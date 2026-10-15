using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// The supervisor enters a kill-on-close job before starting user code. Its children
// inherit membership, including detached grandchildren, but never the job handle.
internal static class PartWindowsRunner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, Stdin, Stdout, Stderr;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern void GetStartupInfo(out StartupInfo info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(IntPtr handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);

    // Quote one Windows argv element, including quotes and trailing backslashes.
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    public static int Main(string[] args)
    {
        IntPtr control = IntPtr.Zero;
        bool launched = false;
        try
        {
            if (args.Length == 0) throw new ArgumentException("Missing interpreter");
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
                !AssignProcessToJobObject(job, new IntPtr(-1))) throw new Win32Exception();

            StartupInfo startup;
            GetStartupInfo(out startup);
            startup.Size = (uint)Marshal.SizeOf(startup);
            // Preserve the CRT descriptor table supplied by Node, including result fd 3.
            startup.Flags |= 0x100; // STARTF_USESTDHANDLES
            // libuv's CRT table: int count, byte flags[count], HANDLE handles[count].
            // Descriptor 4 is a private launch acknowledgment and never enters user code.
            int descriptors = Marshal.ReadInt32(startup.ReservedData);
            if (descriptors != 5) throw new ArgumentException("Invalid supervisor descriptor table");
            int controlOffset = 4 + descriptors + 4 * IntPtr.Size;
            control = Marshal.ReadIntPtr(startup.ReservedData, controlOffset);
            if (!SetHandleInformation(control, 1, 0)) throw new Win32Exception();
            Marshal.WriteByte(startup.ReservedData, 4 + 4, 0);
            Marshal.WriteIntPtr(startup.ReservedData, controlOffset, new IntPtr(-1));
            StringBuilder command = new StringBuilder();
            foreach (string argument in args)
            {
                if (command.Length != 0) command.Append(' ');
                command.Append(Quote(argument));
            }
            ProcessInfo child;
            if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000,
                IntPtr.Zero, null, ref startup, out child)) throw new Win32Exception();
            launched = true;
            byte[] started = Encoding.ASCII.GetBytes("started\n");
            uint written;
            if (!WriteFile(control, started, (uint)started.Length, out written, IntPtr.Zero) ||
                written != started.Length) throw new Win32Exception();
            CloseHandle(control);
            CloseHandle(child.Thread);
            if (WaitForSingleObject(child.Process, 0xffffffff) != 0) throw new Win32Exception();
            uint code;
            if (!GetExitCodeProcess(child.Process, out code)) throw new Win32Exception();
            CloseHandle(child.Process);
            // Also terminate descendants whose immediate parent has already exited.
            if (!TerminateJobObject(job, code)) throw new Win32Exception();
            return unchecked((int)code);
        }
        catch (Exception error)
        {
            if (!launched && control != IntPtr.Zero)
            {
                byte[] failed = Encoding.ASCII.GetBytes("failed\n");
                uint written;
                WriteFile(control, failed, (uint)failed.Length, out written, IntPtr.Zero);
            }
            Console.Error.WriteLine("part Windows process supervisor: " + error.Message);
            return 127;
        }
        // The OS closes the non-inheritable job handle even if this supervisor is killed.
    }
}
