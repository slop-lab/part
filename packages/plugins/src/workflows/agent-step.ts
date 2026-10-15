import { canonical, fail, freeze, isJson, ok } from '@part/core/contracts';
import type { Contracts, Runtime, Workflows } from '@part/core/reference';
/** Native schedulers choose stable logical keys; this adapter owns one attached run. */
export function createAgentStepBinding(
  runs: Runtime.RunService,
  options: { id?: string; maxRetained?: number } = {},
): Workflows.AgentStepBinding {
  const id = options.id ?? 'part/agent-step';
  const records = new Map<
    string,
    { fingerprint: string; result: Promise<Contracts.Result<Contracts.EntityRef>> }
  >();
  const handles = new Map<
    string,
    { handle: Runtime.ExecutionHandle<unknown>; principal: string }
  >();
  return {
    id,
    boundary: freeze({
      owner: id,
      nativeCheckpointUnit: 'whole-agent-invocation',
      innerAgentEffectsCheckpointed: false,
      managedEffectCoverage: ['Managed requests through the configured run service'],
      nativeReplaySemantics:
        'Memory attach within this adapter lifetime; no stack replay or external effect checkpoint',
    }),
    async startOrAttach(logicalKey, request, context) {
      if (!logicalKey || !isJson(request.input))
        return fail('agent-step.request', 'Stable key and JSON input are required');
      const key = canonical({ principal: context.principal, logicalKey });
      const fingerprint = canonical({
        driver: request.driver,
        composition: request.composition.inspection.revision,
        input: request.input,
        limits: (request.limits as unknown as Contracts.Json) ?? null,
        history: (request.history as unknown as Contracts.Json) ?? null,
      });
      const prior = records.get(key);
      if (prior)
        return prior.fingerprint === fingerprint
          ? prior.result
          : fail(
              'agent-step.conflict',
              'Logical step key has different input or configuration',
              'conflict',
            );
      if (records.size >= (options.maxRetained ?? 1000))
        return fail('agent-step.capacity', 'Step attach retention capacity reached');
      const fixed = {
        ...request,
        input: structuredClone(request.input),
        ...(request.limits ? { limits: structuredClone(request.limits) } : {}),
        ...(request.history ? { history: { ...request.history } } : {}),
      };
      const result = Promise.resolve()
        .then(async () => {
          const created = await runs.start(fixed, context);
          if (!created.ok) return created;
          handles.set(created.value.ref.id, {
            handle: created.value,
            principal: canonical(context.principal),
          });
          return ok(created.value.ref);
        })
        .catch(() => fail('agent-step.admission', 'Child admission failed', 'internal', 'unknown'));
      records.set(key, { fingerprint, result });
      return result;
    },
    async result(ref, context) {
      const entry = handles.get(ref.id);
      if (
        !entry ||
        entry.principal !== canonical(context.principal) ||
        canonical(entry.handle.ref as unknown as Contracts.Json) !==
          canonical(ref as unknown as Contracts.Json)
      )
        return fail(
          'agent-step.permission',
          'Attached run is not owned by this caller',
          'permission',
        );
      return ok(await entry.handle.done);
    },
  };
}
