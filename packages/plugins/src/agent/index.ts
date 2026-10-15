/** @public */
import { createPlanner, createScopeManager } from '@slop-lab/part/composition';
import {
  createContextCompiler,
  lowerersKey,
  lowerersPoint,
  messageLowerer,
  transformsKey,
  transformsPoint,
} from '@slop-lab/part/context';
import { emptyCleanup, fail, localContext, ok } from '@slop-lab/part/contracts';
import { createModelGateway } from '@slop-lab/part/model';
import type {
  Composition,
  Context,
  Contracts,
  Convenience,
  Driver,
  Model,
  Runtime,
  Tools,
} from '@slop-lab/part/reference';
import { createOperations } from '@slop-lab/part/runtime';
import type { CostEstimator } from '@slop-lab/part/runtime/costs';
import { createRunService, installDriver } from '@slop-lab/part/runtime/runs';
import { createSuspensions } from '@slop-lab/part/runtime/waits';
import { createToolDispatcher } from '@slop-lab/part/tools';
import type { BasicInput } from './drivers/basic.js';
import { createBasicDriver } from './drivers/basic.js';
export const contextPoint: Composition.ExtensionPoint<Context.Compiler> = {
  id: 'part/context',
  owner: 'part/context',
  contractVersion: 1,
  kind: 'service',
  scope: 'runtime',
};
export const modelPoint: Composition.ExtensionPoint<Model.Gateway> = {
  id: 'part/model',
  owner: 'part/model',
  contractVersion: 1,
  kind: 'service',
  scope: 'runtime',
};
export const toolsPoint: Composition.ExtensionPoint<Tools.Dispatcher> = {
  id: 'part/tools',
  owner: 'part/tools',
  contractVersion: 1,
  kind: 'service',
  scope: 'runtime',
};
export interface AgentOptions extends Convenience.BaseOptions {
  readonly toolSchemas?: Readonly<Record<string, Contracts.Json>>;
  readonly executors?: readonly Tools.Executor[];
  readonly middleware?: readonly Tools.Middleware[];
  readonly boundary?: Runtime.InvocationBoundary;
  readonly principal?: Contracts.InvocationContext['principal'];
  readonly costEstimator?: CostEstimator;
  readonly inspectRequest?: (view: Model.RequestInspection) => void;
}
export function expandAgent(options: AgentOptions & { driver?: Driver.Factory<unknown, unknown> }) {
  const operations = createOperations(),
    waits = createSuspensions();
  const compiler: Context.Compiler = {
    async compile(request, context) {
      const lowerers = context.services.get(lowerersKey),
        transforms = context.services.get(transformsKey);
      if (!lowerers.ok) return lowerers;
      if (!transforms.ok) return transforms;
      const compiled = createContextCompiler({
        lowerers: [...lowerers.value.values()],
        transforms: transforms.value,
        compositionRevision: (
          context as Contracts.InvocationContext & { compositionRevision?: string }
        ).compositionRevision,
      });
      return compiled.ok ? compiled.value.compile(request, context) : compiled;
    },
  };
  const gateway = createModelGateway({
    profiles: [options.model.profile],
    adapters: [options.model.adapter],
    transports: [options.model.transport],
    auth: { [options.model.profile.authStrategyId]: options.model.auth },
    operations,
    boundary: options.boundary,
    inspect: options.inspectRequest,
    costEstimator: options.costEstimator,
  });
  if (!gateway.ok) return gateway;
  const dispatcher = createToolDispatcher({
    tools: options.tools ?? [],
    middleware: options.middleware,
    executors: options.executors,
    operations,
    boundary: options.boundary,
    waits,
    capabilities: options.model.profile.capabilities,
  });
  if (!dispatcher.ok) return dispatcher;
  const advertisements: Model.ToolAdvertisement[] = [];
  for (const definition of dispatcher.value.registry.list(localContext())) {
    const inputSchema = options.toolSchemas?.[definition.id];
    if (!inputSchema)
      return fail('agent.tool-schema', `JSON Schema required for advertised tool ${definition.id}`);
    advertisements.push({
      id: definition.id,
      version: definition.version,
      description: definition.description,
      inputSchema,
      execution: 'runtime',
    });
  }
  const driver =
    options.driver ??
    createBasicDriver({
      profileId: options.model.profile.id,
      tools: advertisements,
      modelCapabilities: options.model.profile.capabilities,
    });
  const base: Composition.ComponentFactory = {
    descriptor: {
      id: 'part/base',
      version: '0.1.0-alpha.2',
      surfaces: ['local', 'server', 'test'],
      scope: 'runtime',
      requires: [],
      provides: [contextPoint, modelPoint, toolsPoint].map((p) => ({
        id: p.id,
        contractVersion: 1,
        status: 'supported',
        implementedBy: 'part/base',
        constraints: {},
      })),
    },
    register(registry) {
      const lowerers = registry.declare(lowerersPoint);
      if (!lowerers.ok) return lowerers;
      const transforms = registry.declare(transformsPoint);
      if (!transforms.ok) return transforms;
      const contributed = registry.contribute({
        id: 'part/default-message-lowerer',
        point: lowerersPoint,
        key: 'part/message@1',
        value: messageLowerer,
      });
      if (!contributed.ok) return contributed;
      for (const [point, value, id] of [
        [contextPoint, compiler, 'part/base-context'],
        [modelPoint, gateway.value, 'part/base-model'],
        [toolsPoint, dispatcher.value, 'part/base-tools'],
      ] as const) {
        const declared = registry.declare(point as Composition.ExtensionPoint<unknown>);
        if (!declared.ok) return declared;
        const contributed = registry.contribute({
          id,
          point: point as Composition.ExtensionPoint<unknown>,
          value,
        });
        if (!contributed.ok) return contributed;
      }
      return ok(undefined);
    },
    create() {
      return ok({
        initialize: async () => ok(undefined),
        start: async () => ok(undefined),
        stop: async () => emptyCleanup(),
        dispose: async () => emptyCleanup(),
      });
    },
  };
  const specification: Composition.CompositionSpec = {
    components: [base, ...(options.components ?? [])],
    config: {},
  };
  return ok({ specification, driver, operations, waits });
}
export function createAgent(
  options: AgentOptions & { driver?: never },
): Contracts.Result<Convenience.Agent<BasicInput, Model.Response>>;
export function createAgent<I, O>(
  options: AgentOptions & { driver: Driver.Factory<I, O> },
): Contracts.Result<Convenience.Agent<I, O>>;
export function createAgent(
  options: AgentOptions & { driver?: Driver.Factory<unknown, unknown> },
): Contracts.Result<Convenience.Agent<unknown, unknown>> {
  options = {
    ...options,
    ...(options.limits ? { limits: Object.freeze(structuredClone(options.limits)) } : {}),
  };
  const expanded = expandAgent(options);
  if (!expanded.ok) return expanded;
  const { specification, driver, operations, waits } = expanded.value;
  const resolved = createPlanner().resolve(
    options.customize ? options.customize(specification) : specification,
  );
  if (!resolved.ok) return resolved;
  const scope = { kind: 'runtime', id: crypto.randomUUID() },
    scopeCancellation = new AbortController(),
    active = new Set<Runtime.ExecutionHandle<unknown>>(),
    starting = new Set<Promise<Contracts.Result<Runtime.ExecutionHandle<unknown>>>>();
  let opened: Promise<Contracts.Result<Composition.ScopeLease>> | undefined,
    disposed = false,
    disposing: Promise<Contracts.CleanupReport> | undefined;
  const context = localContext({
    scope,
    signal: scopeCancellation.signal,
    ...(options.principal ? { principal: options.principal } : {}),
  });
  const manager = createScopeManager({ context });
  const start = async (
    input: unknown,
  ): Promise<Contracts.Result<Runtime.ExecutionHandle<unknown>>> => {
    if (disposed) return fail('agent.disposed', 'Agent is disposed', 'conflict');
    let fixedInput: unknown;
    try {
      fixedInput = structuredClone(input);
    } catch {
      return fail('agent.input', 'Input is not cloneable');
    }
    const lease = await (opened ??= manager.open(scope, resolved.value));
    if (!lease.ok) return lease;
    if (disposed) return fail('agent.disposed', 'Agent is disposed', 'conflict');
    const model = lease.value.services.get(modelPoint),
      tools = lease.value.services.get(toolsPoint),
      compiler = lease.value.services.get(contextPoint);
    if (!model.ok) return model;
    if (!tools.ok) return tools;
    if (!compiler.ok) return compiler;
    const service = createRunService({
      drivers: [installDriver(driver)],
      operations,
      services: {
        model: model.value,
        tools: tools.value,
        context: compiler.value,
        operations,
        waits,
        services: lease.value.services,
      },
    });
    if (!service.ok) return service;
    const created = await service.value.start(
      {
        driver: driver.id,
        input: fixedInput,
        composition: resolved.value,
        limits: options.limits,
      },
      { ...context, services: lease.value.services },
    );
    if (created.ok) {
      if (disposed) await created.value.requestCancel('agent-dispose');
      active.add(created.value);
      void created.value.done.then(() => {
        active.delete(created.value);
      });
    }
    return created;
  };
  return ok({
    start(input) {
      const pending = start(input).catch(() =>
        fail('agent.start', 'Agent admission failed', 'internal', 'not-attempted'),
      );
      starting.add(pending);
      void pending.then(() => starting.delete(pending));
      return pending;
    },
    async generate(input) {
      const created = await this.start(input);
      return created.ok ? ok(await created.value.done) : created;
    },
    inspectComposition: () => resolved.value.inspection,
    dispose() {
      return (disposing ??= (async () => {
        disposed = true;
        scopeCancellation.abort();
        const admitted = await Promise.all([...starting]);
        const handles = [
          ...new Set([
            ...active,
            ...admitted.flatMap((result) => (result.ok ? [result.value] : [])),
          ]),
        ];
        await Promise.all(handles.map((handle) => handle.requestCancel('agent-dispose')));
        const outcomes = await Promise.all(handles.map((handle) => handle.done));
        const lease = opened ? await opened : undefined;
        const cleanup = lease?.ok ? await lease.value.close() : emptyCleanup();
        return {
          ...cleanup,
          unresolved: [
            ...cleanup.unresolved,
            ...handles.filter((_, i) => outcomes[i]!.phase === 'abandoned').map((h) => h.ref),
          ],
        };
      })());
    },
  });
}
