import type { Contracts as C, Driver as D, Model as M, Context as X, Runtime as R } from './reference.js';
import { ok, fail, schema, isJson, isJsonObject, emptyCleanup } from './contracts.js';
import { messageItem } from './context.js';
export type BasicInput = string | readonly X.SemanticItem[];
export const basicInputSchema = schema<BasicInput>('part/basic-input', (v): v is BasicInput => typeof v === 'string' || Array.isArray(v) && v.every(item => isJsonObject(item) && typeof item.id === 'string' && typeof item.type === 'string' && Number.isSafeInteger(item.schemaVersion) && isJson(item.payload) && isJsonObject(item.source) && isJsonObject(item.provenance)));
export const modelResponseSchema = schema<M.Response>('part/model-response', (v): v is M.Response => isJsonObject(v) && Array.isArray(v.content) && Array.isArray(v.toolCalls) && v.toolCalls.every(call => isJsonObject(call) && typeof call.id === 'string' && typeof call.toolId === 'string' && isJson(call.arguments)) && isJsonObject(v.finish) && typeof v.finish.normalized === 'string' && isJsonObject(v.usage));
export function createBasicDriver(options: { profileId: string; tools?: readonly M.ToolAdvertisement[]; modelCapabilities?: C.CapabilitySet; maxTurns?: number; inspectContext?: (context: X.CompiledContext) => void }): D.Factory<BasicInput, M.Response> {
  const advertisements = structuredClone(options.tools ?? []), capabilities = structuredClone(options.modelCapabilities ?? { revision: 'memory', entries: [] });
  return { id: 'part/basic', version: '1', input: basicInputSchema, output: modelResponseSchema,
    requires: [{ id: 'part/model', contractVersion: 1, optional: false }, { id: 'part/context', contractVersion: 1, optional: false }, ...(advertisements.length ? [{ id: 'part/tools', contractVersion: 1, optional: false }] : [])],
    create(services) {
      return { async execute(input, context) {
        let effect: C.EffectState = 'not-attempted'; const commit: C.CommitEvidence[] = [];
        const failure = (error: C.Failure): R.ManagedOutcome<M.Response> => ({ phase: 'failed', error, effect, commit, unsettledChildren: [] });
        if (!services.model || !services.context) return failure({ code: 'part.driver.services', category: 'unsupported', message: 'Basic driver requires model and context services', retry: 'never' });
        const items: X.SemanticItem[] = typeof input === 'string' ? [await messageItem('user', [{ kind: 'text', text: input }])] : structuredClone([...input]);
        for (let turn = 0; turn < (options.maxTurns ?? 8); turn++) {
          if (context.signal.aborted) return { phase: 'cancelled', effect, commit, unsettledChildren: [] };
          const compiled = await services.context.compile({ input: items, sources: items.map(item => item.source), toolsDigest: JSON.stringify(advertisements), modelCapabilities: capabilities }, context);
          if (!compiled.ok) return failure(compiled.error); options.inspectContext?.(compiled.value);
          const invocation = await services.model.invoke({ profileId: options.profileId, context: compiled.value, tools: advertisements, options: {} }, context);
          if (!invocation.ok) return failure(invocation.error);
          const progress = relay(invocation.value, context);
          const response = await invocation.value.done; await progress;
          commit.push(...response.commit); effect = combineEffects(effect, response.effect);
          if (response.phase !== 'completed') return { ...response, effect, commit };
          if (!response.result.toolCalls.length) return { phase: 'completed', result: response.result, effect, commit, unsettledChildren: [] };
          if (!services.tools) return failure({ code: 'part.driver.tools', category: 'unsupported', message: 'Model requested tools without a dispatcher', retry: 'never' });
          items.push(await messageItem('assistant', response.result.content));
          for (const call of response.result.toolCalls) {
            const advertised = advertisements.find(t => t.id === call.toolId && t.execution === 'runtime');
            if (!advertised) return failure({ code: 'part.driver.tool-not-advertised', category: 'permission', message: 'Model requested an unadvertised runtime tool', retry: 'never' });
            items.push(await messageItem('assistant', [{ kind: 'json', value: call.arguments }], { callId: call.id, toolId: call.toolId }));
            const dispatched = await services.tools.dispatch({ logicalCallId: call.id, modelCallId: invocation.value.ref.id, toolId: call.toolId, expectedToolVersion: advertised.version, arguments: call.arguments }, context);
            if (!dispatched.ok) return failure(dispatched.error);
            const toolProgress = relay(dispatched.value, context);
            const result = await dispatched.value.done; await toolProgress; commit.push(...result.commit); effect = combineEffects(effect, result.effect);
            if (result.phase !== 'completed') return { ...result, effect, commit };
            const content: M.ContentPart[] = [...result.result.content];
            if (result.result.value !== undefined) { if (!isJson(result.result.value)) return failure({ code: 'part.driver.tool-result', category: 'validation', message: 'Tool value is not JSON', retry: 'never' }); content.push({ kind: 'json', value: result.result.value }); }
            items.push(await messageItem('tool', content, { callId: call.id, toolId: call.toolId }));
          }
        }
        return failure({ code: 'part.driver.turn-limit', category: 'conflict', message: 'Basic driver turn limit exceeded', retry: 'never' });
      }, describeActions: () => [], async receive() { return fail('driver.receive', 'Basic driver has no live input actions', 'unsupported'); }, async dispose() { return emptyCleanup(); } };
    },
  };
}
export function combineEffects(a: C.EffectState, b: C.EffectState): C.EffectState {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === 'partially-applied' || b === 'partially-applied') return 'partially-applied';
  if (a === 'applied' || b === 'applied') return 'applied';
  return a === 'not-attempted' ? b : a;
}
async function relay(handle: R.ExecutionHandle<unknown>, context: C.InvocationContext): Promise<void> {
  const progress = (context as C.InvocationContext & { progress?: R.ProgressSink }).progress;
  if (!progress) return;
  for await (const update of handle.observe()) {
    if (update.kind === 'data') progress.publish(update.type, update.payload);
    else progress.publish('part.operation/gap', { from: update.from, to: update.to });
  }
}
/** A second control strategy: completion requires validation after model stop. */
export function createValidatingDriver<I, O>(base: D.Factory<I, M.Response>, output: C.Schema<O>, validate: (response: M.Response, context: C.InvocationContext) => Promise<C.Result<O>>): D.Factory<I, O> {
  return { ...base, id: `${base.id}/validated`, output, create(services, ref) {
    const instance = base.create(services, ref);
    return { ...instance, async execute(input, context) {
      const outcome = await instance.execute(input, context); if (outcome.phase !== 'completed') return outcome;
      const validated = await validate(outcome.result, context); if (!validated.ok) return { ...outcome, phase: 'failed', error: validated.error };
      const checked = output.validate(validated.value); return checked.ok ? { ...outcome, result: checked.value } : { ...outcome, phase: 'failed', error: { code: 'part.driver.validation', category: 'validation', message: 'Final result validation failed', retry: 'never' } };
    } };
  } };
}
