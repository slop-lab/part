/** @public */
import { digest, fail, isJson, ok } from '@slop-lab/part/contracts';
import type { Contracts, Runtime, Scripts } from '@slop-lab/part/reference';
import { createBoundary, createOperations, managedAttempt, reserve } from '@slop-lab/part/runtime';
import { isScriptRequest } from '@slop-lab/part/scripts';
import { resolve } from 'node:path';
import { runScriptProcess } from './process.js';
import { resolveScriptSource } from './source.js';
import type { NodeScriptOptions, NodeScriptService } from './types.js';
export type { NodeScriptOptions, NodeScriptService } from './types.js';
export function createNodeScripts(options: NodeScriptOptions): NodeScriptService {
  options = {
    ...options,
    root: resolve(options.root),
    interpreters: { ...options.interpreters },
    environments: structuredClone(options.environments ?? {}),
  };
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
      const prepared = await resolveScriptSource(options, request, context);
      if (!prepared.ok) return prepared;
      const { bytes, workspace } = prepared.value;
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

            const result = await runScriptProcess(options, {
              request: fixed,
              bytes,
              workspace,
              executionDigest,
              context: c,
              interpreters,
              environments,
            });
            unresolvedPid = result.unresolvedPid;
            return result.outcome;
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
                      'Process tree termination is unconfirmed',
                      'unavailable',
                      'unknown',
                    ).error,
              unsettledChildren: [
                {
                  owner: 'part/node-process',
                  kind: 'process-tree',
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
