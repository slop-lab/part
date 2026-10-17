// @ts-check
import { createPlanner, createScopeManager } from '@slop-lab/part/composition/index.js';
import { emptyCleanup, fail, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createRunService, installDriver } from '@slop-lab/part/runtime/runs.js';
import { contextPoint, modelPoint, toolsPoint } from '@slop-lab/part-plugins/agent/index.js';
import { modelResponseSchema } from '@slop-lab/part-plugins/agent/drivers/basic.js';

/**
 * @typedef {{
 *   runs: import('@slop-lab/part/runtime/runs.js').RunControlService,
 *   model: import('@slop-lab/part/reference/index.js').Model.Gateway,
 *   operations: import('@slop-lab/part/runtime/operations.js').Operations,
 *   waits: import('@slop-lab/part/reference/index.js').Runtime.SuspensionPort,
 *   compiler: import('@slop-lab/part/reference/index.js').Context.Compiler,
 *   composition: import('@slop-lab/part/reference/index.js').Composition.CompositionHandle,
 *   rootDriverId: string,
 *   context: import('@slop-lab/part/reference/index.js').Contracts.InvocationContext
 * }} ExecutionServices
 * @typedef {{
 *   specification: import('@slop-lab/part/reference/index.js').Composition.CompositionSpec,
 *   drivers: readonly import('@slop-lab/part/reference/index.js').Driver.Factory<unknown, unknown>[],
 *   rootDriver: import('@slop-lab/part/reference/index.js').Driver.Factory<import('@slop-lab/part-plugins/agent/drivers/basic.js').BasicInput, import('@slop-lab/part/reference/index.js').Model.Response>,
 *   operations: import('@slop-lab/part/runtime/operations.js').Operations,
 *   waits: import('@slop-lab/part/reference/index.js').Runtime.SuspensionPort,
 *   limits?: import('@slop-lab/part/reference/index.js').Runtime.ExecutionLimits,
 *   principal?: import('@slop-lab/part/reference/index.js').Contracts.InvocationContext['principal'],
 *   customize?: (base: import('@slop-lab/part/reference/index.js').Composition.CompositionSpec) => import('@slop-lab/part/reference/index.js').Composition.CompositionSpec,
 *   prepareInput: (input: import('@slop-lab/part-plugins/agent/drivers/basic.js').BasicInput) => Promise<import('@slop-lab/part-plugins/agent/drivers/basic.js').BasicInput>
 * }} ExecutionRootOptions
 * @typedef {import('@slop-lab/part/reference/index.js').Convenience.Agent<import('@slop-lab/part-plugins/agent/drivers/basic.js').BasicInput, import('@slop-lab/part/reference/index.js').Model.Response> & {
 *   executionServices(): Promise<import('@slop-lab/part/reference/index.js').Contracts.Result<ExecutionServices>>
 * }} CarExecutionAgent
 */

/** Build one scope and one run service shared by convenience and workflow surfaces.
 * @param {ExecutionRootOptions} options
 * @returns {import('@slop-lab/part/reference/index.js').Contracts.Result<CarExecutionAgent>}
 */
export function createExecutionRoot(options) {
  const resolved = createPlanner().resolve(
    options.customize ? options.customize(options.specification) : options.specification,
  );
  if (!resolved.ok) return resolved;
  const scope = { kind: /** @type {const} */ ('runtime'), id: crypto.randomUUID() };
  const cancellation = new AbortController();
  const baseContext = localContext({
    scope,
    signal: cancellation.signal,
    ...(options.principal ? { principal: options.principal } : {}),
  });
  const manager = createScopeManager({ context: baseContext });
  /** @type {Set<import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<unknown>>} */
  const active = new Set();
  /** @type {Set<Promise<import('@slop-lab/part/reference/index.js').Contracts.Result<import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<unknown>>>>} */
  const starting = new Set();
  /** @type {Promise<import('@slop-lab/part/reference/index.js').Contracts.Result<import('@slop-lab/part/reference/index.js').Composition.ScopeLease>> | undefined} */
  let opened;
  /** @type {Promise<import('@slop-lab/part/reference/index.js').Contracts.Result<ExecutionServices>> | undefined} */
  let services;
  /** @type {Promise<import('@slop-lab/part/reference/index.js').Contracts.CleanupReport> | undefined} */
  let disposing;
  let disposed = false;

  const executionServices = () =>
    (services ??= (async () => {
      if (disposed) return fail('car.disposed', 'Agent is disposed', 'conflict');
      const lease = await (opened ??= manager.open(scope, resolved.value));
      if (!lease.ok) return lease;
      if (disposed) return fail('car.disposed', 'Agent is disposed', 'conflict');
      const model = lease.value.services.get(modelPoint);
      const tools = lease.value.services.get(toolsPoint);
      const compiler = lease.value.services.get(contextPoint);
      if (!model.ok) return model;
      if (!tools.ok) return tools;
      if (!compiler.ok) return compiler;
      const raw = createRunService({
        drivers: options.drivers.map(installDriver),
        operations: options.operations,
        services: {
          model: model.value,
          tools: tools.value,
          context: compiler.value,
          operations: options.operations,
          waits: options.waits,
          services: lease.value.services,
        },
      });
      if (!raw.ok) return raw;
      /** @type {import('@slop-lab/part/runtime/runs.js').RunControlService} */
      const runs = {
        ...raw.value,
        async start(request, context) {
          if (disposed) return fail('car.disposed', 'Agent is disposed', 'conflict');
          const pending = raw.value.start(request, context);
          starting.add(pending);
          const created = await pending.finally(() => starting.delete(pending));
          if (created.ok) {
            active.add(created.value);
            if (disposed) await created.value.requestCancel('car-dispose');
            void created.value.done.then(() => active.delete(created.value));
          }
          return created;
        },
      };
      const context = { ...baseContext, services: lease.value.services };
      return ok({
        runs,
        model: model.value,
        operations: options.operations,
        waits: options.waits,
        compiler: compiler.value,
        composition: resolved.value,
        rootDriverId: options.rootDriver.id,
        context,
      });
    })());

  /** @type {CarExecutionAgent} */
  const agent = {
    async start(input) {
      if (disposed) return fail('car.disposed', 'Agent is disposed', 'conflict');
      let fixed;
      try {
        fixed = await options.prepareInput(structuredClone(input));
      } catch {
        return fail('car.input', 'Input is not cloneable');
      }
      const ready = await executionServices();
      if (!ready.ok) return ready;
      const created = await ready.value.runs.start(
        {
          driver: options.rootDriver.id,
          input: fixed,
          composition: ready.value.composition,
          ...(options.limits ? { limits: options.limits } : {}),
        },
        ready.value.context,
      );
      return created.ok ? ok(modelResponseHandle(created.value)) : created;
    },
    async generate(input) {
      const created = await this.start(input);
      return created.ok ? ok(await created.value.done) : created;
    },
    executionServices,
    inspectComposition: () => resolved.value.inspection,
    dispose() {
      return (disposing ??= (async () => {
        disposed = true;
        cancellation.abort();
        await Promise.all([...starting]);
        const handles = [...active];
        await Promise.all(handles.map((handle) => handle.requestCancel('car-dispose')));
        const outcomes = await Promise.all(handles.map((handle) => handle.done));
        const lease = opened ? await opened : undefined;
        const cleanup = lease?.ok ? await lease.value.close() : emptyCleanup();
        return {
          ...cleanup,
          unresolved: [
            ...cleanup.unresolved,
            ...handles
              .filter((_, index) => outcomes[index]?.phase === 'abandoned')
              .map((h) => h.ref),
          ],
        };
      })());
    },
  };
  return ok(agent);
}

/** Validate the generic run port before exposing a typed coding handle.
 * @param {import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<unknown>} handle
 * @returns {import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<import('@slop-lab/part/reference/index.js').Model.Response>}
 */
export function modelResponseHandle(handle) {
  return {
    ...handle,
    done: handle.done.then((outcome) => {
      if (outcome.phase !== 'completed') return outcome;
      const checked = modelResponseSchema.validate(outcome.result);
      return checked.ok
        ? { ...outcome, result: checked.value }
        : {
            phase: /** @type {const} */ ('failed'),
            error: fail('car.run-output', 'Coding run output validation failed').error,
            effect: outcome.effect,
            commit: outcome.commit,
            unsettledChildren: outcome.unsettledChildren,
          };
    }),
  };
}
