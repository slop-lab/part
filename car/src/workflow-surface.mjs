// @ts-check
import { jsonSchema, ok } from '@slop-lab/part/contracts/index.js';
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createWorkflowEndpoint } from '@slop-lab/part-plugins/workflows/endpoint.js';
import { createCarWorkflowRegistry } from './workflows.mjs';

/** @typedef {{schemas?: Parameters<typeof createCarWorkflowRegistry>[0]['schemas'],
 * codeDefinitions?: Parameters<typeof createCarWorkflowRegistry>[0]['codeDefinitions'],
 * handlers?: Parameters<typeof createCarWorkflowRegistry>[0]['handlers']}} WorkflowOptions */

/** @param {{root: string, execution: import('./execution.mjs').ExecutionServices,
 * boundary: import('@slop-lab/part/reference/index.js').Runtime.InvocationBoundary,
 * hub: ReturnType<import('@slop-lab/part/client/watch.js').createWatchHub>,
 * limits?: import('@slop-lab/part/reference/index.js').Runtime.ExecutionLimits,
 * options?: WorkflowOptions}} setup */
export async function createCarWorkflowSurface(setup) {
  const { execution } = setup;
  const registry = await createCarWorkflowRegistry({
    root: setup.root,
    schemas: [jsonSchema, ...(setup.options?.schemas ?? [])],
    context: execution.context,
    services: {
      operations: execution.operations,
      model: execution.model,
      runs: execution.runs,
      waits: execution.waits,
      scripts: createNodeScripts({
        root: setup.root,
        interpreters: { node: process.execPath },
        operations: execution.operations,
        boundary: setup.boundary,
      }),
    },
    agents: { coding: { driver: execution.rootDriverId, composition: execution.composition } },
    ...(setup.options?.codeDefinitions ? { codeDefinitions: setup.options.codeDefinitions } : {}),
    ...(setup.options?.handlers ? { handlers: setup.options.handlers } : {}),
  });
  if (!registry.ok) return registry;
  const composition = execution.composition.inspection;
  return createWorkflowEndpoint({
    host: registry.value.host,
    context: execution.context,
    ...(setup.limits ? { limits: setup.limits } : {}),
    composition: { id: composition.id, revision: composition.revision },
    registrations: registry.value.definitions.map((definition) => {
      const prepared = registry.value.prepare(definition.id);
      if (!prepared.ok) throw new Error(prepared.error.message);
      return { definition, engineId: prepared.value.engine.id, profileIds: ['default'] };
    }),
    async project(snapshot) {
      const engine = registry.value.host.resolve(snapshot.ref.engine);
      const inspected = engine.ok
        ? await engine.value.inspect?.(snapshot.ref, 'waits', execution.context)
        : undefined;
      const value = {
        id: snapshot.ref.id,
        type: 'part/workflow',
        schemaVersion: 1,
        revision: snapshot.revision,
        source: { owner: snapshot.ref.engine, kind: 'part/workflow', id: snapshot.ref.id },
        payload: {
          phase: snapshot.phase,
          effect: snapshot.effect,
          guarantees: { ...snapshot.guarantees },
          diagnostics: snapshot.diagnostics.map((error) => ({ ...error })),
          waits: inspected?.ok ? inspected.value.data : [],
          ...(snapshot.output ? { output: JSON.parse(JSON.stringify(snapshot.output)) } : {}),
        },
        fallback: { label: 'CAR workflow', text: `${snapshot.phase} · effect ${snapshot.effect}` },
        actions: [...snapshot.actions],
        artifacts: [],
      };
      return ok(value);
    },
    mirror: (item) => setup.hub.upsert(item),
  });
}
