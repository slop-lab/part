import type { Contracts as C, Tools as T, Runtime as R } from './reference.js';
import { ok, fail, digest, isJson, freeze } from './contracts.js';
import { createOperations, createBoundary, managedAttempt } from './runtime.js';
import type { Operations } from './runtime.js';
import { reserve } from './model.js';

interface LocalBinding { definition: T.Definition<unknown, unknown>; execute(input: unknown, context: T.ExecutionContext): Promise<C.Result<T.ResultContent>> }
const installed = new WeakMap<object, LocalBinding>();
export function installTool<I, O>(binding: T.FunctionBinding<I, O>): T.InstalledTool {
  const tool = Object.freeze({ id: binding.definition.id, version: binding.definition.version, localBinding: {} });
  installed.set(tool.localBinding, { definition: Object.freeze({ ...binding.definition, requiredCapabilities: Object.freeze([...binding.definition.requiredCapabilities]) }) as T.Definition<unknown, unknown>,
    async execute(input, context) {
      const validated = binding.definition.input.validate(input);
      return validated.ok ? binding.execute(validated.value, context) : fail('tool.input', 'Input validation failed');
    } });
  return tool;
}
export function functionTool<I, O>(options: { id: string; input: C.Schema<I>; output: C.Schema<O>; execute(input: I, context: T.ExecutionContext): Promise<O> | O; description?: string; effects?: T.Definition<I, O>['effects'] }): T.InstalledTool {
  return installTool({ definition: { id: options.id, version: '1', description: options.description ?? options.id, input: options.input, output: options.output,
    executor: 'part/function', effects: options.effects ?? 'read', cancellation: 'cooperative', retrySafety: 'never', requiredCapabilities: [] },
    async execute(input, context) { const value = await options.execute(input, context); return ok({ value, content: [], artifacts: [], diagnostics: [] }); } });
}
export interface ToolDispatcher extends T.Dispatcher { readonly registry: T.Registry }
export function createToolDispatcher(options: { tools: readonly T.InstalledTool[]; middleware?: readonly T.Middleware[]; executors?: readonly T.Executor[]; boundary?: R.InvocationBoundary; operations?: Operations; waits?: R.SuspensionPort; capabilities?: C.CapabilitySet; compositionRevision?: string; maxHops?: number }): C.Result<ToolDispatcher> {
  const bindings = new Map<string, LocalBinding>(), executors = new Map<string, T.Executor>();
  for (const tool of options.tools) {
    const binding = typeof tool.localBinding === 'object' && tool.localBinding !== null ? installed.get(tool.localBinding) : undefined;
    if (!binding || tool.id !== binding.definition.id || tool.version !== binding.definition.version) return fail('tool.binding', `Invalid installed binding ${tool.id}`);
    if (bindings.has(tool.id)) return fail('tool.duplicate', tool.id, 'conflict');
    bindings.set(tool.id, binding);
  }
  for (const executor of options.executors ?? []) { if (executors.has(executor.id) || executor.id === 'part/function') return fail('executor.duplicate', executor.id); executors.set(executor.id, executor); }
  const middleware = [...(options.middleware ?? [])];
  if (new Set(middleware.map(m => m.id)).size !== middleware.length) return fail('middleware.duplicate', 'Duplicate middleware ID');
  const operations = options.operations ?? createOperations(), boundary = options.boundary ?? createBoundary();
  const resolve: T.Registry['resolve'] = (id, version) => { const definition = bindings.get(id)?.definition; return !definition ? fail('tool.missing', id, 'unsupported') : version && definition.version !== version ? fail('tool.version', id, 'conflict') : ok(definition); };
  const registry: T.Registry = { resolve, list: () => [...bindings.values()].map(b => b.definition) };
  const failed = (error: C.Failure, effect: C.EffectState = 'not-attempted'): R.ManagedOutcome<T.ResultContent> => ({ phase: 'failed', error, effect, commit: [], unsettledChildren: [] });
  const validate = async (call: T.Call, hops: string[], executorOverride?: string): Promise<C.Result<T.CallPlan>> => {
    const resolved = resolve(call.toolId, call.expectedToolVersion); if (!resolved.ok) return resolved;
    const definition = resolved.value, checked = definition.input.validate(call.arguments);
    if (!checked.ok || !isJson(checked.value)) return fail('tool.input', `Invalid arguments for ${call.toolId}`);
    for (const capability of definition.requiredCapabilities) if (!options.capabilities?.entries.some(c => c.id === capability && c.status === 'supported')) return fail('tool.capability', capability, 'unsupported');
    const executorId = executorOverride ?? definition.executor;
    if (executorId !== 'part/function' && !executors.has(executorId)) return fail('executor.missing', executorId, 'unsupported');
    const fixedArguments = freeze(structuredClone(checked.value));
    const revision = options.compositionRevision ?? 'memory';
    return ok({ call: { ...call, arguments: fixedArguments }, definition, validatedArguments: fixedArguments, executorId, revision,
      digest: await digest({ tool: definition.id, version: definition.version, executorId, arguments: fixedArguments, revision }), hops });
  };
  return ok({ registry, async dispatch(call, context) {
    const initial = await validate({ ...call }, []); if (!initial.ok) return initial;
    const timeout = initial.value.definition.timeoutMs;
    const deadline = timeout === undefined ? context.deadline : new Date(Math.min(Date.now() + timeout, context.deadline ? Date.parse(context.deadline) : Infinity)).toISOString();
    return operations.begin({ kind: 'part/tool', retryOwner: 'part/tools', childPolicy: 'attached' }, async c => {
      const dispatchBudget = reserve(c, 'maxToolDispatches'); if (!dispatchBudget.ok) return failed(dispatchBudget.error);
      let plan = initial.value, substitute: T.ResultContent | undefined, changes = 0;
      const approved = new Map<string, string>();
      for (let i = 0; i < middleware.length;) {
        if (c.signal.aborted) return { phase: 'cancelled', effect: 'not-attempted', commit: [], unsettledChildren: [] };
        const policy = middleware[i]!;
        let decision: C.Result<T.Decision>;
        if (approved.get(policy.id) === plan.digest) { i++; continue; }
        try { decision = await policy.decide(plan, c); } catch { return failed({ code: 'part.tool.policy', category: 'internal', message: 'Tool policy failed', retry: 'never' }); }
        if (!decision.ok) return failed(decision.error);
        let result = decision.value;
        if (result.kind === 'suspend') {
          if (!options.waits || !policy.resume) return failed({ code: 'part.tool.suspend', category: 'unsupported', message: 'Suspension service and resume handler are required', retry: 'never' });
          if (result.ticket.bindingDigest !== plan.digest) return failed({ code: 'part.tool.binding', category: 'conflict', message: 'Wait is not bound to current plan', retry: 'never' });
          const ticket = await options.waits.open(result.ticket, c); if (!ticket.ok) return failed(ticket.error);
          c.progress.publish('part.tool/wait', ticket.value as unknown as C.Json);
          const response = await c.wait(options.waits.wait(ticket.value, result.ticket.responseSchema, c)); if (!response.ok) return failed(response.error);
          const resumed = await policy.resume(plan, ticket.value, response.value, c); if (!resumed.ok) return failed(resumed.error);
          result = resumed.value; if (result.kind === 'suspend') return failed({ code: 'part.tool.suspend-loop', category: 'conflict', message: 'Resume cannot immediately suspend again', retry: 'never' });
          if (result.kind === 'allow') approved.set(policy.id, plan.digest);
        }
        if (result.kind === 'deny') return failed(result.error);
        if (result.kind === 'allow') { i++; continue; }
        if (result.kind === 'substitute') { substitute = structuredClone(result.result); i++; continue; }
        if (++changes > (options.maxHops ?? 16)) return failed({ code: 'part.tool.hop-limit', category: 'conflict', message: 'Tool rewrite limit exceeded', retry: 'never' });
        const rewritten: T.Call = { ...plan.call, arguments: result.arguments, ...(result.kind === 'redirect' && result.toolId ? { toolId: result.toolId, expectedToolVersion: undefined } : {}) };
        const next = await validate(rewritten, [...plan.hops, plan.digest], result.kind === 'redirect' ? result.executorId : plan.executorId);
        if (!next.ok) return failed(next.error);
        if (plan.hops.includes(next.value.digest) || next.value.digest === plan.digest) return failed({ code: 'part.tool.rewrite-cycle', category: 'conflict', message: 'Tool rewrite cycle', retry: 'never' });
        plan = next.value; substitute = undefined; i = 0;
      }
      const executionContext: T.ExecutionContext = { ...c, operationId: c.scope.id, attemptId: crypto.randomUUID(), progress: c.progress };
      const effectPlan: R.EffectPlan = { operationId: c.scope.id, attemptId: executionContext.attemptId, target: plan.definition.id, executor: plan.executorId,
        inputDigest: plan.digest, scopeDigest: await digest({ principal: c.principal, scope: { ...c.scope } }), compositionRevision: plan.revision, classification: plan.definition.effects };
      return managedAttempt(boundary, effectPlan, async permit => {
        let attempted: R.AttemptOutcome<T.ResultContent>;
        if (substitute) attempted = { kind: 'returned', value: substitute, effect: 'not-applied' };
        else if (plan.executorId === 'part/function') {
          const attemptBudget = reserve(c, 'maxExecutorAttempts'); if (!attemptBudget.ok) return { kind: 'failed', error: attemptBudget.error, effect: 'not-attempted' };
          const result = await bindings.get(plan.definition.id)!.execute(plan.validatedArguments, executionContext);
          attempted = result.ok ? { kind: 'returned', value: result.value, effect: plan.definition.effects === 'read' ? 'not-applied' : 'applied' } : { kind: 'failed', error: result.error, effect: result.error.effect ?? 'unknown' };
        } else { const attemptBudget = reserve(c, 'maxExecutorAttempts'); if (!attemptBudget.ok) return { kind: 'failed', error: attemptBudget.error, effect: 'not-attempted' }; attempted = await executors.get(plan.executorId)!.execute(plan, permit, executionContext); }
        if (attempted.kind === 'returned' && plan.definition.output) {
          const checked = plan.definition.output.validate(attempted.value.value);
          if (!checked.ok) return { kind: 'failed', effect: attempted.effect, error: { code: 'part.tool.output', category: 'validation', message: 'Tool output validation failed', retry: 'never' } };
          attempted = { ...attempted, value: { ...attempted.value, value: checked.value } };
        }
        c.progress.publish('part.tool/result', { toolId: plan.definition.id, outcome: attempted.kind, effect: attempted.effect, substituted: !!substitute });
        return attempted;
      }, c);
    }, { ...context, ...(deadline ? { deadline } : {}) });
  } });
}
