import { fail, isJson, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Runtime, Scripts } from '@slop-lab/part/reference/index.js';
import type { OperationContext } from '@slop-lab/part/runtime/index.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { windowsRunner } from './windows.js';
import type { NodeScriptOptions } from './types.js';
export async function runScriptProcess(
  options: NodeScriptOptions,
  input: {
    request: Scripts.Request;
    bytes: Uint8Array;
    workspace: string;
    executionDigest: string;
    context: OperationContext;
    interpreters: Readonly<Record<string, string>>;
    environments: Readonly<Record<string, Readonly<Record<string, string>>>>;
  },
): Promise<{ outcome: Runtime.AttemptOutcome<Scripts.Output>; unresolvedPid?: number }> {
  const {
    request: fixed,
    bytes,
    workspace,
    executionDigest,
    context: c,
    interpreters,
    environments,
  } = input;
  let unresolvedPid: number | undefined;
  const outcome = await execute();
  return { outcome, unresolvedPid };
  async function execute(): Promise<Runtime.AttemptOutcome<Scripts.Output>> {
    const temporary = await mkdtemp(join(tmpdir(), 'part-script-')),
      snapshot = join(temporary, `source${extname(fixed.source.relativePath)}`);
    const maximum = options.maxOutputBytes ?? 1024 * 1024;
    let processStarted = false;
    try {
      await writeFile(snapshot, bytes, { mode: 0o400 });
      if (c.signal.aborted) return { kind: 'cancelled', effect: 'not-attempted' };
      const bridgeEnvironment = fixed.bridgeGrant
        ? options.bridge!.environment(fixed.bridgeGrant, c, fixed.source.relativePath)
        : ok({});
      if (!bridgeEnvironment.ok)
        return {
          kind: 'failed',
          error: bridgeEnvironment.error,
          effect: 'not-attempted',
        };
      const windows = process.platform === 'win32';
      const interpreter = interpreters[fixed.interpreter]!;
      let executable = interpreter;
      if (windows) {
        try {
          executable = await windowsRunner();
        } catch (error) {
          return {
            kind: 'failed',
            effect: 'not-attempted',
            error: fail(
              'scripts.windows-runtime',
              error instanceof Error ? error.message : 'Windows supervisor unavailable',
              'unavailable',
            ).error,
          };
        }
      }
      if (c.signal.aborted) return { kind: 'cancelled', effect: 'not-attempted' };
      const child = spawn(
        executable,
        [...(windows ? [interpreter] : []), snapshot, ...fixed.args],
        {
          cwd: workspace,
          env: {
            ...(fixed.environmentProfile ? environments[fixed.environmentProfile] : {}),
            ...bridgeEnvironment.value,
          },
          stdio: windows
            ? ['pipe', 'pipe', 'pipe', fixed.capture.kind === 'channel' ? 'pipe' : 'ignore', 'pipe']
            : fixed.capture.kind === 'channel'
              ? ['pipe', 'pipe', 'pipe', 'pipe']
              : ['pipe', 'pipe', 'pipe'],
          detached: !windows,
          windowsHide: true,
        },
      );
      processStarted = true;
      const stdout: Buffer[] = [];
      let channelBuffer = Buffer.alloc(0),
        channelBytes = 0,
        channelError = false,
        channelResult: Contracts.Json | undefined,
        channelReturned = false;
      let outBytes = 0,
        errorBytes = 0,
        truncated = false,
        spawnError = false,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      let launchAcknowledged = !windows;
      let supervisorFailed = false;
      if (windows) {
        const control = child.stdio[4] as import('node:stream').Readable;
        let message = '';
        control.on('data', (chunk: Buffer) => {
          message += chunk.toString('ascii');
          launchAcknowledged = message === 'started\n';
          supervisorFailed = message === 'failed\n';
        });
      }
      const terminate = () => {
        if (!child.pid) return;
        try {
          process.kill(windows ? child.pid : -child.pid, 'SIGTERM');
        } catch {}
        killTimer ??= setTimeout(() => {
          try {
            process.kill(windows ? child.pid! : -child.pid!, 'SIGKILL');
          } catch {}
        }, 50);
      };
      c.signal.addEventListener('abort', terminate, { once: true });
      child.on('exit', () => terminate());
      child.on('error', () => {
        spawnError = true;
      });
      child.stdin!.on('error', () => {});
      child.stdout!.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes <= maximum) stdout.push(chunk);
        else {
          truncated = true;
          terminate();
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        errorBytes += chunk.length;
        if (errorBytes > maximum) {
          truncated = true;
          terminate();
        }
      });
      if (fixed.capture.kind === 'channel') {
        const capture = fixed.capture;
        const channel = child.stdio[3] as import('node:stream').Readable;
        channel.on('data', (chunk: Buffer) => {
          channelBytes += chunk.length;
          if (channelBytes > maximum) {
            truncated = true;
            terminate();
            return;
          }
          channelBuffer = Buffer.concat([channelBuffer, chunk]);
          let newline: number;
          while ((newline = channelBuffer.indexOf(10)) >= 0) {
            const line = channelBuffer.subarray(0, newline);
            channelBuffer = channelBuffer.subarray(newline + 1);
            try {
              const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
              if (
                !isJsonObject(frame) ||
                Object.keys(frame).some(
                  (k) => !['protocolVersion', 'channelId', 'kind', 'payload'].includes(k),
                ) ||
                frame.protocolVersion !== 1 ||
                frame.channelId !== capture.channelId ||
                !Object.hasOwn(frame, 'payload')
              )
                throw new Error('Invalid channel frame');
              if (frame.kind === 'progress')
                c.progress.publish('part.script/channel-progress', frame.payload!);
              else if (
                frame.kind === 'result' &&
                !channelReturned &&
                Buffer.byteLength(JSON.stringify(frame.payload)) <= capture.maxBytes
              ) {
                channelResult = structuredClone(frame.payload!);
                channelReturned = true;
              } else throw new Error('Invalid channel result');
            } catch {
              channelError = true;
              terminate();
            }
          }
        });
      }
      child.stdin!.end(fixed.stdin === undefined ? undefined : JSON.stringify(fixed.stdin));
      if (c.signal.aborted) terminate();
      const exited = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.on('close', (code, signal) => resolve({ code, signal })),
      );
      c.signal.removeEventListener('abort', terminate);
      clearTimeout(killTimer);
      let unresolved = false;
      if (child.pid) {
        try {
          process.kill(windows ? child.pid : -child.pid, 0);
          unresolved = true;
        } catch {}
      }
      if (unresolved) {
        try {
          process.kill(windows ? child.pid! : -child.pid!, 'SIGKILL');
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 30));
        try {
          process.kill(windows ? child.pid! : -child.pid!, 0);
        } catch {
          unresolved = false;
        }
      }
      if (spawnError || supervisorFailed)
        return {
          kind: 'failed',
          effect: 'not-attempted',
          error: fail('scripts.spawn', 'Process did not start', 'unavailable').error,
        };
      if (!launchAcknowledged && !c.signal.aborted)
        return {
          kind: 'failed',
          effect: fixed.effects === 'read' ? 'not-applied' : 'unknown',
          error: fail('scripts.supervisor', 'Script launch acknowledgment was lost', 'unavailable')
            .error,
        };
      const effect: Contracts.EffectState =
        fixed.effects === 'read'
          ? 'not-applied'
          : unresolved || c.signal.aborted
            ? 'unknown'
            : 'applied';
      if (unresolved) {
        unresolvedPid = child.pid;
        return {
          kind: 'failed',
          effect: 'unknown',
          error: {
            code: 'part.scripts.process-tree',
            category: 'unavailable',
            message: 'Process tree termination is unconfirmed',
            retry: 'after-reconciliation',
          },
        };
      }
      if (c.signal.aborted) return { kind: 'cancelled', effect };
      if (truncated)
        return {
          kind: 'failed',
          effect,
          error: fail('scripts.truncated', 'Output exceeded byte limit').error,
        };
      let captured: Scripts.Output['captured'];
      if (fixed.capture.kind === 'channel') {
        if (channelError || channelBuffer.length || !channelReturned)
          return {
            kind: 'failed',
            effect,
            error: fail('scripts.channel-result', 'Expected one complete versioned channel result')
              .error,
          };
        captured = { kind: 'inline', value: channelResult! };
      } else if (fixed.capture.kind !== 'none') {
        let output: Uint8Array = Buffer.concat(stdout);
        if (fixed.capture.kind === 'file') {
          const actual = await realpath(resolve(workspace, fixed.capture.relativePath)),
            local = relative(await realpath(workspace), actual);
          if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local))
            return {
              kind: 'failed',
              effect,
              error: fail('scripts.capture-path', 'Capture file is outside the root', 'permission')
                .error,
            };
          if ((await stat(actual)).size > fixed.capture.maxBytes)
            return {
              kind: 'failed',
              effect,
              error: fail('scripts.capture-size', 'Capture too large').error,
            };
          output = await readFile(actual);
        }
        if (output.byteLength > fixed.capture.maxBytes)
          return {
            kind: 'failed',
            effect,
            error: fail('scripts.capture-size', 'Capture too large').error,
          };
        try {
          const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(output),
          );
          if (!isJson(value)) throw Error('Invalid JSON');
          captured = { kind: 'inline', value };
        } catch {
          return {
            kind: 'failed',
            effect,
            error: fail(
              'scripts.capture-json',
              'Capture must contain exactly one complete UTF-8 JSON value',
            ).error,
          };
        }
      }
      return {
        kind: 'returned',
        value: {
          exitCode: exited.code,
          termination: exited.signal ? 'signal' : 'exited',
          completeness: 'complete',
          executionDigest,
          ...(captured ? { captured } : {}),
        },
        effect,
      };
    } catch {
      return {
        kind: 'failed',
        effect: processStarted ? 'unknown' : 'not-attempted',
        error: fail('scripts.execution', 'Script execution failed', 'unavailable').error,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
