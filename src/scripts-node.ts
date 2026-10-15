import { spawn } from 'node:child_process';
import { readFile, realpath, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, extname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Contracts, Scripts, Runtime, Tools } from './reference.js';
import type { Operations } from './runtime.js';
import { ok, fail, digest, isJson, isJsonObject } from './contracts.js';
import { createOperations, createBoundary, managedAttempt } from './runtime.js';
import { reserve } from './model.js';
import { isScriptRequest } from './scripts.js';
import type { ScriptBridgeEnvironment } from './script-bridge-node.js';
export interface NodeScriptService extends Scripts.Service {
  executor(id?: string): Tools.Executor;
}
export function createNodeScripts(options: {
  root: string;
  interpreters: Readonly<Record<string, string>>;
  environments?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  operations?: Operations;
  boundary?: Runtime.InvocationBoundary;
  maxOutputBytes?: number;
  bridge?: ScriptBridgeEnvironment;
  source?: (
    source: Scripts.Source,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<Uint8Array>>;
  workspace?: (
    ref: Contracts.DataRef,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<string>>;
  maxSourceBytes?: number;
}): NodeScriptService {
  const root = resolve(options.root),
    interpreters = { ...options.interpreters },
    environments = structuredClone(options.environments ?? {}),
    operations = options.operations ?? createOperations(),
    boundary = options.boundary ?? createBoundary();
  const consumedPermits = new WeakSet<object>();
  const delegated = new WeakMap<Contracts.InvocationContext, { digest: string; used: boolean }>();
  const service: NodeScriptService = {
    executor(id = 'part/node-script') {
      return {
        id,
        capabilities: {
          revision: '1',
          entries: [
            {
              id: 'part/scripts',
              contractVersion: 1,
              status: 'supported',
              implementedBy: id,
              constraints: { attempts: 'shared-with-dispatcher' },
            },
          ],
        },
        async execute(plan, permit, context) {
          if (
            !isScriptRequest(plan.validatedArguments) ||
            plan.definition.effects !== plan.validatedArguments.effects
          )
            return {
              kind: 'failed',
              effect: 'not-attempted',
              error: fail(
                'scripts.tool-plan',
                'Tool effect classification and script request must agree',
              ).error,
            };
          const expectedPlan: Runtime.EffectPlan = {
            operationId: context.operationId,
            attemptId: context.attemptId,
            target: plan.definition.id,
            executor: plan.executorId,
            inputDigest: plan.digest,
            scopeDigest: await digest({
              principal: context.principal,
              scope: { ...context.scope },
            }),
            compositionRevision: plan.revision,
            classification: plan.definition.effects,
          };
          if (
            permit.attemptId !== context.attemptId ||
            permit.planDigest !== (await digest(expectedPlan as unknown as Contracts.Json)) ||
            consumedPermits.has(permit)
          )
            return {
              kind: 'failed',
              effect: 'not-attempted',
              error: fail(
                'scripts.permit',
                'Script executor requires an unused matching dispatcher permit',
              ).error,
            };
          consumedPermits.add(permit);
          const fixedContext = { ...context };
          delegated.set(fixedContext, {
            digest: await digest(plan.validatedArguments as unknown as Contracts.Json),
            used: false,
          });
          const created = await service.execute(plan.validatedArguments, fixedContext);
          if (!created.ok) return { kind: 'failed', effect: 'not-attempted', error: created.error };
          const outcome = await created.value.done;
          if (outcome.phase !== 'completed')
            return {
              kind: 'failed',
              effect: outcome.effect,
              error:
                'error' in outcome && outcome.error
                  ? outcome.error
                  : fail(
                      'scripts.tool-cancelled',
                      'Script tool cancelled',
                      'cancelled',
                      outcome.effect,
                    ).error,
            };
          if (outcome.result.exitCode !== 0 || outcome.result.completeness !== 'complete')
            return {
              kind: 'failed',
              effect: outcome.effect,
              error: fail(
                'scripts.tool-exit',
                'Script tool did not complete successfully',
                'internal',
                outcome.effect,
              ).error,
            };
          return {
            kind: 'returned',
            effect: outcome.effect,
            value: {
              ...(outcome.result.captured?.kind === 'inline'
                ? { value: outcome.result.captured.value }
                : {}),
              content: [],
              artifacts: [],
              diagnostics: [
                {
                  exitCode: outcome.result.exitCode,
                  executionDigest: outcome.result.executionDigest,
                },
              ],
            },
          };
        },
      };
    },
    async execute(request, context) {
      if (!isScriptRequest(request))
        return fail('scripts.request', 'Request must be lossless JSON');
      request = structuredClone(request);
      const shared = delegated.get(context);
      if (shared) {
        if (shared.used || shared.digest !== (await digest(request as unknown as Contracts.Json)))
          return fail(
            'scripts.shared-attempt',
            'Shared script attempt is consumed or changed',
            'conflict',
          );
        shared.used = true;
      }
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
      if (request.bridgeGrant && !options.bridge)
        return fail('scripts.bridge', 'No script IPC bridge is installed', 'unsupported');
      if (
        (request.workspace && !options.workspace) ||
        (request.source.packageId && !options.source)
      )
        return fail(
          'scripts.source-profile',
          'Workspace/package resolvers are not installed',
          'unsupported',
        );
      if (request.environmentProfile && !Object.hasOwn(environments, request.environmentProfile))
        return fail('scripts.environment', 'Environment profile not installed', 'unsupported');
      if (request.capture.kind === 'file' && request.capture.mediaType !== 'application/json')
        return fail('scripts.media', 'Only JSON file capture is installed', 'unsupported');
      if (
        request.capture.kind === 'channel' &&
        (request.capture.protocolVersion !== 1 || !request.capture.channelId)
      )
        return fail(
          'scripts.channel',
          'Unknown channel protocol or missing channel ID',
          'unsupported',
        );
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
      let bytes: Uint8Array,
        workspace = root;
      if (request.workspace) {
        const selected = await options.workspace!(request.workspace, context);
        if (!selected.ok) return selected;
        workspace = await realpath(selected.value);
      }
      if (request.source.packageId) {
        const selected = await options.source!(request.source, context);
        if (!selected.ok) return selected;
        bytes = selected.value.slice();
      } else {
        try {
          const actual = await realpath(resolve(root, path)),
            base = await realpath(root),
            local = relative(base, actual);
          if (!local || local === '..' || local.startsWith('../') || isAbsolute(local))
            return fail('scripts.path', 'Script is outside the configured root', 'permission');
          if ((await stat(actual)).size > (options.maxSourceBytes ?? 16 * 1024 * 1024))
            return fail('scripts.source-size', 'Script exceeds source byte limit');
          bytes = await readFile(actual);
        } catch {
          return fail('scripts.source', 'Script source unavailable', 'unavailable');
        }
      }
      if (bytes.length > (options.maxSourceBytes ?? 16 * 1024 * 1024))
        return fail('scripts.source-size', 'Script exceeds source byte limit');
      if ((await digest(bytes)) !== request.source.digest)
        return fail('scripts.digest', 'Script content changed', 'conflict');
      const fixed = structuredClone(request),
        executionDigest = await digest(fixed as unknown as Contracts.Json);
      const deadlines = [
        context.deadline ? Date.parse(context.deadline) : Infinity,
        request.timeoutMs ? Date.now() + request.timeoutMs : Infinity,
      ];
      const deadline = Math.min(...deadlines);
      return operations.begin<Scripts.Output>(
        { kind: 'part/script', childPolicy: 'attached', retryOwner: 'part/scripts' },
        async (c) => {
          const attemptId = crypto.randomUUID(),
            plan: Runtime.EffectPlan = {
              operationId: c.scope.id,
              attemptId,
              target: fixed.source.relativePath,
              executor: fixed.executorId,
              inputDigest: executionDigest,
              scopeDigest: await digest({
                root,
                workspace,
                environment: fixed.environmentProfile ?? null,
              }),
              compositionRevision: 'memory',
              classification: fixed.effects,
            };
          let unresolvedPid: number | undefined;
          const executeAttempt = async (): Promise<Runtime.AttemptOutcome<Scripts.Output>> => {
            const budget = shared ? ok(undefined) : reserve(c, 'maxExecutorAttempts');
            if (!budget.ok) return { kind: 'failed', error: budget.error, effect: 'not-attempted' };
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
              const child = spawn(interpreters[fixed.interpreter]!, [snapshot, ...fixed.args], {
                cwd: workspace,
                env: {
                  ...(fixed.environmentProfile ? environments[fixed.environmentProfile] : {}),
                  ...bridgeEnvironment.value,
                },
                stdio:
                  fixed.capture.kind === 'channel'
                    ? ['pipe', 'pipe', 'pipe', 'pipe']
                    : ['pipe', 'pipe', 'pipe'],
                detached: true,
              });
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
                      const frame = JSON.parse(
                        new TextDecoder('utf-8', { fatal: true }).decode(line),
                      );
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
              child.stdin.end(fixed.stdin === undefined ? undefined : JSON.stringify(fixed.stdin));
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
              let captured: Scripts.Output['captured'];
              if (fixed.capture.kind === 'channel') {
                if (channelError || channelBuffer.length || !channelReturned)
                  return {
                    kind: 'failed',
                    effect,
                    error: fail(
                      'scripts.channel-result',
                      'Expected one complete versioned channel result',
                    ).error,
                  };
                captured = { kind: 'inline', value: channelResult! };
              } else if (fixed.capture.kind !== 'none') {
                let output: Uint8Array = Buffer.concat(stdout);
                if (fixed.capture.kind === 'file') {
                  const actual = await realpath(resolve(workspace, fixed.capture.relativePath)),
                    local = relative(await realpath(workspace), actual);
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
          };
          const borrowed = async (): Promise<Runtime.ManagedOutcome<Scripts.Output>> => {
            const result = await executeAttempt();
            return result.kind === 'returned'
              ? {
                  phase: 'completed',
                  result: result.value,
                  effect: result.effect,
                  commit: [],
                  unsettledChildren: [],
                }
              : result.kind === 'failed'
                ? {
                    phase: 'failed',
                    error: result.error,
                    effect: result.effect,
                    commit: [],
                    unsettledChildren: [],
                  }
                : { phase: 'cancelled', effect: result.effect, commit: [], unsettledChildren: [] };
          };
          const outcome = shared
            ? await borrowed()
            : await managedAttempt<Scripts.Output>(boundary, plan, executeAttempt, c);

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
  return service;
}
