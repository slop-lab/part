import type { Contracts as C, Composition as P, Workflows as W } from './reference.js';
import { ok, fail } from './contracts.js';
export const enginesPoint: P.ExtensionPoint<W.Engine> = {
  id: 'part.workflow/engines',
  owner: 'part/workflow-host',
  contractVersion: 1,
  kind: 'registry',
  scope: 'runtime',
};
export function createWorkflowHost(engines: readonly W.Engine[]): C.Result<W.Host> {
  const registry = new Map(engines.map((engine) => [engine.descriptor.id, engine]));
  if (registry.size !== engines.length)
    return fail('workflow.duplicate', 'Duplicate workflow engine', 'conflict');
  const resolve = (id: string): C.Result<W.Engine> =>
    registry.has(id)
      ? ok(registry.get(id)!)
      : fail('workflow.engine', `Engine not installed: ${id}`, 'unsupported');
  return ok({
    engines: enginesPoint,
    resolve,
    async prepare(request, context) {
      const engine = resolve(request.engineId);
      if (!engine.ok) return engine;
      if (
        !engine.value.descriptor.formats.some(
          (f) =>
            f.id === request.definition.format &&
            f.versions.includes(request.definition.formatVersion),
        )
      )
        return fail('workflow.format', 'Workflow format is not installed', 'unsupported');
      for (const requirement of request.requiredCapabilities)
        if (
          !engine.value.descriptor.capabilities.entries.some(
            (c) => c.id === requirement && c.status === 'supported',
          )
        )
          return fail('workflow.capability', requirement, 'unsupported');
      const prepared = await engine.value.prepare(request, context);
      if (!prepared.ok) return prepared;
      if (
        request.requiredControl === 'runner-enforced' &&
        prepared.value.guarantees.control !== 'runner-enforced'
      )
        return fail('workflow.control', 'Required control guarantee is unavailable', 'unsupported');
      return prepared;
    },
    async start(request, context) {
      const engine = resolve(request.prepared.engine.id);
      return engine.ok
        ? engine.value.start(request, context)
        : { kind: 'rejected', error: engine.error };
    },
  });
}
