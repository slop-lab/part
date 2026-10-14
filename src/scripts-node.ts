import { spawn } from 'node:child_process';
import { readFile, realpath, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, extname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Contracts as C, Scripts as S, Runtime as R } from './reference.js';
import type { Operations } from './runtime.js';
import { ok, fail, digest, isJson } from './contracts.js';
import { createOperations, createBoundary, managedAttempt } from './runtime.js';
import { reserve } from './model.js';
export function createNodeScripts(options: {
  root: string;
  interpreters: Readonly<Record<string, string>>;
  environments?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  operations?: Operations;
  boundary?: R.InvocationBoundary;
  maxOutputBytes?: number;
}): S.Service {
  const root = resolve(options.root),
    interpreters = { ...options.interpreters },
    environments = structuredClone(options.environments ?? {}),
    operations = options.operations ?? createOperations(),
    boundary = options.boundary ?? createBoundary();
  return {
    async execute(request, context) {
      if (!isJson(request)) return fail('scripts.request', 'Request must be lossless JSON');
      request = structuredClone(request);
      if (context.signal.aborted)
        return fail('scripts.cancelled', 'Script cancelled before admission', 'cancelled');
      if (process.platform === 'win32')
        return fail(
          'scripts.platform',
          'This reference host requires POSIX process groups',
          'unsupported',
        );
      if (
        request.executorId !== 'part/node-process' ||
        !Object.hasOwn(interpreters, request.interpreter)
      )
        return fail('scripts.executor', 'Executor or interpreter not installed', 'unsupported');
      if (request.bridgeGrant)
        return fail('scripts.bridge', 'No script IPC bridge is installed', 'unsupported');
      if (request.workspace || request.source.packageId)
        return fail(
          'scripts.source-profile',
          'Workspace/package resolvers are not installed',
          'unsupported',
        );
      if (request.environmentProfile && !Object.hasOwn(environments, request.environmentProfile))
        return fail('scripts.environment', 'Environment profile not installed', 'unsupported');
      if (request.capture.kind === 'file' && request.capture.mediaType !== 'application/json')
        return fail('scripts.media', 'Only JSON file capture is installed', 'unsupported');
      if (request.capture.kind === 'channel')
        return fail('scripts.channel', 'Capture channel not installed', 'unsupported');
      if (
        !isJson(request) ||
        !Array.isArray(request.args) ||
        request.args.some((a) => typeof a !== 'string')
      )
        return fail('scripts.request', 'Invalid script request');
      if (
        request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
      )
        return fail('scripts.timeout', 'Invalid timeout');
      if (
        request.capture.kind !== 'none' &&
        (!Number.isSafeInteger(request.capture.maxBytes) || request.capture.maxBytes < 1)
      )
        return fail('scripts.capture-limit', 'Invalid capture size limit');
      const path = request.source.relativePath;
      if (isAbsolute(path)) return fail('scripts.path', 'Script path must be relative');
      let bytes: Uint8Array;
      try {
        const actual = await realpath(resolve(root, path)),
          base = await realpath(root),
          local = relative(base, actual);
        if (!local || local === '..' || local.startsWith('../') || isAbsolute(local))
          return fail('scripts.path', 'Script is outside the configured root', 'permission');
        bytes = await readFile(actual);
      } catch {
        return fail('scripts.source', 'Script source unavailable', 'unavailable');
      }
      if ((await digest(bytes)) !== request.source.digest)
        return fail('scripts.digest', 'Script content changed', 'conflict');
      const fixed = structuredClone(request),
        executionDigest = await digest(fixed as unknown as C.Json);
      const deadlines = [
        context.deadline ? Date.parse(context.deadline) : Infinity,
        request.timeoutMs ? Date.now() + request.timeoutMs : Infinity,
      ];
      const deadline = Math.min(...deadlines);
      return operations.begin<S.Output>(
        { kind: 'part/script', childPolicy: 'attached', retryOwner: 'part/scripts' },
        async (c) => {
          const attemptId = crypto.randomUUID(),
            plan: R.EffectPlan = {
              operationId: c.scope.id,
              attemptId,
              target: fixed.source.relativePath,
              executor: fixed.executorId,
              inputDigest: executionDigest,
              scopeDigest: await digest({ root, environment: fixed.environmentProfile ?? null }),
              compositionRevision: 'memory',
              classification: fixed.effects,
            };
          let unresolvedPid: number | undefined;
          const outcome = await managedAttempt<S.Output>(
            boundary,
            plan,
            async () => {
              const budget = reserve(c, 'maxExecutorAttempts');
              if (!budget.ok)
                return { kind: 'failed', error: budget.error, effect: 'not-attempted' };
              const temporary = await mkdtemp(join(tmpdir(), 'part-script-')),
                snapshot = join(temporary, `source${extname(fixed.source.relativePath)}`);
              const maximum = options.maxOutputBytes ?? 1024 * 1024;
              let processStarted = false;
              try {
                await writeFile(snapshot, bytes, { mode: 0o400 });
                if (c.signal.aborted) return { kind: 'cancelled', effect: 'not-attempted' };
                const child = spawn(interpreters[fixed.interpreter]!, [snapshot, ...fixed.args], {
                  cwd: root,
                  env: fixed.environmentProfile ? environments[fixed.environmentProfile] : {},
                  stdio: ['pipe', 'pipe', 'pipe'],
                  detached: true,
                });
                processStarted = true;
                const stdout: Buffer[] = [];
                let outBytes = 0,
                  errorBytes = 0,
                  truncated = false,
                  spawnError = false,
                  killTimer: ReturnType<typeof setTimeout> | undefined;
                const terminate = () => {
                  if (!child.pid) return;
                  try {
                    process.kill(-child.pid, 'SIGTERM');
                  } catch {}
                  killTimer ??= setTimeout(() => {
                    try {
                      process.kill(-child.pid!, 'SIGKILL');
                    } catch {}
                  }, 50);
                };
                c.signal.addEventListener('abort', terminate, { once: true });
                child.on('exit', () => terminate());
                child.on('error', () => {
                  spawnError = true;
                });
                child.stdin.on('error', () => {});
                child.stdout.on('data', (chunk: Buffer) => {
                  outBytes += chunk.length;
                  if (outBytes <= maximum) stdout.push(chunk);
                  else {
                    truncated = true;
                    terminate();
                  }
                });
                child.stderr.on('data', (chunk: Buffer) => {
                  errorBytes += chunk.length;
                  if (errorBytes > maximum) {
                    truncated = true;
                    terminate();
                  }
                });
                child.stdin.end(
                  fixed.stdin === undefined ? undefined : JSON.stringify(fixed.stdin),
                );
                if (c.signal.aborted) terminate();
                const exited = await new Promise<{ code: number | null; signal: string | null }>(
                  (resolve) => child.on('close', (code, signal) => resolve({ code, signal })),
                );
                c.signal.removeEventListener('abort', terminate);
                clearTimeout(killTimer);
                let unresolved = false;
                if (child.pid) {
                  try {
                    process.kill(-child.pid, 0);
                    unresolved = true;
                  } catch {}
                }
                if (unresolved) {
                  try {
                    process.kill(-child.pid!, 'SIGKILL');
                  } catch {}
                  await new Promise((resolve) => setTimeout(resolve, 30));
                  try {
                    process.kill(-child.pid!, 0);
                  } catch {
                    unresolved = false;
                  }
                }
                if (spawnError)
                  return {
                    kind: 'failed',
                    effect: 'not-attempted',
                    error: fail('scripts.spawn', 'Process did not start', 'unavailable').error,
                  };
                const effect: C.EffectState =
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
                      message: 'Process group termination is unconfirmed',
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
                let captured: S.Output['captured'];
                if (fixed.capture.kind !== 'none') {
                  let output: Uint8Array = Buffer.concat(stdout);
                  if (fixed.capture.kind === 'file') {
                    const actual = await realpath(resolve(root, fixed.capture.relativePath)),
                      local = relative(await realpath(root), actual);
                    if (!local || local === '..' || local.startsWith('../') || isAbsolute(local))
                      return {
                        kind: 'failed',
                        effect,
                        error: fail(
                          'scripts.capture-path',
                          'Capture file is outside the root',
                          'permission',
                        ).error,
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
            },
            c,
          );
          if (unresolvedPid && outcome.phase !== 'completed')
            return {
              ...outcome,
              phase: 'abandoned',
              error:
                'error' in outcome && outcome.error
                  ? outcome.error
                  : fail(
                      'scripts.process-tree',
                      'Process group termination is unconfirmed',
                      'unavailable',
                      'unknown',
                    ).error,
              unsettledChildren: [
                {
                  owner: 'part/node-process',
                  kind: 'process-group',
                  id: String(unresolvedPid ?? attemptId),
                },
              ],
            };
          return outcome;
        },
        {
          ...context,
          ...(Number.isFinite(deadline) ? { deadline: new Date(deadline).toISOString() } : {}),
        },
      );
    },
  };
}
