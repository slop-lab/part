import type { Contracts as C, Composition as P, Convenience as V, Context as X, Model as M, Driver as D, Tools as T, Runtime as R } from './reference.js';
import { ok, fail, localContext, emptyCleanup } from './contracts.js';
import { createPlanner, createScopeManager } from './composition.js';
import { createOperations } from './runtime.js';
import { createContextCompiler } from './context.js';
import { createModelGateway } from './model.js';
import { createToolDispatcher } from './tools.js';
import { createBasicDriver } from './driver-basic.js';
import type { BasicInput } from './driver-basic.js';
import { installDriver, createRunService } from './runs.js';
import { createSuspensions } from './waits.js';
export const contextPoint: P.ExtensionPoint<X.Compiler> = { id: 'part/context', owner: 'part/context', contractVersion: 1, kind: 'service', scope: 'runtime' };
export const modelPoint: P.ExtensionPoint<M.Gateway> = { id: 'part/model', owner: 'part/model', contractVersion: 1, kind: 'service', scope: 'runtime' };
export const toolsPoint: P.ExtensionPoint<T.Dispatcher> = { id: 'part/tools', owner: 'part/tools', contractVersion: 1, kind: 'service', scope: 'runtime' };
export interface AgentOptions extends V.BaseOptions { readonly toolSchemas?: Readonly<Record<string, C.Json>>; readonly middleware?: readonly T.Middleware[]; readonly boundary?: R.InvocationBoundary; readonly principal?: C.InvocationContext['principal']; readonly inspectRequest?: (view: M.RequestInspection) => void }
export function expandAgent(options: AgentOptions & { driver?: D.Factory<unknown, unknown> }) {
  const operations = createOperations(), waits = createSuspensions();
  const compiler = createContextCompiler(); if (!compiler.ok) return compiler;
  const gateway = createModelGateway({ profiles: [options.model.profile], adapters: [options.model.adapter], transports: [options.model.transport], auth: { [options.model.profile.authStrategyId]: options.model.auth }, operations, boundary: options.boundary, inspect: options.inspectRequest }); if (!gateway.ok) return gateway;
  const dispatcher = createToolDispatcher({ tools: options.tools ?? [], middleware: options.middleware, operations, boundary: options.boundary, waits, capabilities: options.model.profile.capabilities }); if (!dispatcher.ok) return dispatcher;
  const advertisements: M.ToolAdvertisement[] = [];
  for (const definition of dispatcher.value.registry.list(localContext())) {
    const inputSchema = options.toolSchemas?.[definition.id]; if (!inputSchema) return fail('agent.tool-schema', `JSON Schema required for advertised tool ${definition.id}`);
    advertisements.push({ id: definition.id, version: definition.version, description: definition.description, inputSchema, execution: 'runtime' });
  }
  const driver = options.driver ?? createBasicDriver({ profileId: options.model.profile.id, tools: advertisements, modelCapabilities: options.model.profile.capabilities });
  const base: P.ComponentFactory = {
    descriptor: { id: 'part/base', version: '0.1.0-alpha.1', surfaces: ['local','server','test'], scope: 'runtime', requires: [], provides: [contextPoint,modelPoint,toolsPoint].map(p => ({ id: p.id, contractVersion: 1, status: 'supported', implementedBy: 'part/base', constraints: {} })) },
    register(registry) {
      for (const [point, value, id] of [[contextPoint, compiler.value, 'part/base-context'], [modelPoint, gateway.value, 'part/base-model'], [toolsPoint, dispatcher.value, 'part/base-tools']] as const) {
        const declared = registry.declare(point as P.ExtensionPoint<unknown>); if (!declared.ok) return declared;
        const contributed = registry.contribute({ id, point: point as P.ExtensionPoint<unknown>, value }); if (!contributed.ok) return contributed;
      }
      return ok(undefined);
    }, create() { return ok({ initialize: async () => ok(undefined), start: async () => ok(undefined), stop: async () => emptyCleanup(), dispose: async () => emptyCleanup() }); },
  };
  const specification: P.CompositionSpec = { components: [base, ...(options.components ?? [])], config: {} };
  return ok({ specification, driver, operations, waits });
}
export function createAgent(options: AgentOptions & { driver?: never }): C.Result<V.Agent<BasicInput, M.Response>>;
export function createAgent<I, O>(options: AgentOptions & { driver: D.Factory<I, O> }): C.Result<V.Agent<I, O>>;
export function createAgent(options: AgentOptions & { driver?: D.Factory<unknown, unknown> }): C.Result<V.Agent<unknown, unknown>> {
  const expanded = expandAgent(options); if (!expanded.ok) return expanded;
  const { specification, driver, operations, waits } = expanded.value;
  const resolved = createPlanner().resolve(options.customize ? options.customize(specification) : specification); if (!resolved.ok) return resolved;
  const scope = { kind: 'runtime', id: crypto.randomUUID() }, manager = createScopeManager(), active = new Set<R.ExecutionHandle<unknown>>();
  let opened: Promise<C.Result<P.ScopeLease>> | undefined, disposed = false, disposing: Promise<C.CleanupReport> | undefined;
  const context = localContext({ scope, ...(options.principal ? { principal: options.principal } : {}) });
  return ok({ async start(input) {
    if (disposed) return fail('agent.disposed', 'Agent is disposed', 'conflict');
    const lease = await (opened ??= manager.open(scope, resolved.value)); if (!lease.ok) return lease;
    if (disposed) return fail('agent.disposed', 'Agent is disposed', 'conflict');
    const model = lease.value.services.get(modelPoint), tools = lease.value.services.get(toolsPoint), compiler = lease.value.services.get(contextPoint);
    if (!model.ok) return model; if (!tools.ok) return tools; if (!compiler.ok) return compiler;
    const service = createRunService({ drivers: [installDriver(driver)], operations, services: { model: model.value, tools: tools.value, context: compiler.value, operations, waits, services: lease.value.services } }); if (!service.ok) return service;
    const created = await service.value.start({ driver: driver.id, input, composition: resolved.value, limits: options.limits }, { ...context, services: lease.value.services });
    if (created.ok) { active.add(created.value); void created.value.done.then(() => { active.delete(created.value); }); }
    return created;
  }, async generate(input) { const created = await this.start(input); return created.ok ? ok(await created.value.done) : created; }, inspectComposition: () => resolved.value.inspection,
  dispose() { return disposing ??= (async () => { disposed = true; const handles = [...active]; await Promise.all(handles.map(handle => handle.requestCancel('agent-dispose'))); const outcomes = await Promise.all(handles.map(handle => handle.done)); const lease = opened ? await opened : undefined; const cleanup = lease?.ok ? await lease.value.close() : emptyCleanup(); return { ...cleanup, unresolved: [...cleanup.unresolved, ...handles.filter((_, i) => outcomes[i]!.phase === 'abandoned').map(h => h.ref)] }; })(); } });
}
