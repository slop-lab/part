import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let runner: Promise<string> | undefined;

/** Compile the small Job Object supervisor with the compiler included in Windows .NET Framework. */
export function windowsRunner(): Promise<string> {
  return (runner ??= compile().catch((error: unknown) => {
    runner = undefined;
    throw error;
  }));
}

async function compile(): Promise<string> {
  const source = fileURLToPath(new URL('./windows-runner.cs', import.meta.url));
  const hash = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  const cached = join(tmpdir(), `part-windows-runner-${process.arch}-${hash}.exe`);
  try {
    await access(cached);
    return cached;
  } catch {}
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const compilers = ['Framework64', 'Framework'].map((framework) =>
    join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'),
  );
  let compiler: string | undefined;
  for (const path of compilers) {
    try {
      await access(path);
      compiler = path;
      break;
    } catch {}
  }
  if (!compiler) throw Error('Windows script execution requires the .NET Framework C# compiler');
  const temporary = await mkdtemp(join(tmpdir(), 'part-windows-build-'));
  const output = join(temporary, 'runner.exe');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        compiler,
        [
          '/nologo',
          '/optimize+',
          '/target:exe',
          `/platform:${process.arch === 'ia32' ? 'x86' : 'anycpu'}`,
          `/out:${output}`,
          source,
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let diagnostics = '';
      child.stdout.on('data', (chunk: Buffer) => (diagnostics += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (diagnostics += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(Error(`Windows supervisor compilation failed: ${diagnostics}`)),
      );
    });
    try {
      await rename(output, cached);
    } catch (error) {
      // Another process may have populated and started the same cached executable.
      try {
        await access(cached);
      } catch {
        throw error;
      }
    }
    return cached;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
