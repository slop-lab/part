import { fail, freeze, isJson, ok } from '../contracts/index.js';
import type { Contracts } from '../reference/contracts.js';
import type { Projection } from '../reference/projection.js';
export function createProjectionService(options: {
  authorize(
    target: Contracts.EntityRef,
    audience: Projection.Audience,
    context: Contracts.InvocationContext,
  ): Promise<boolean> | boolean;
  load(
    target: Contracts.EntityRef,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<{ type: string; schemaVersion: number; value: unknown }>>;
  projectors: ReadonlyMap<string, Projection.Projector<unknown>>;
}): Projection.Service {
  return {
    async read(target, audience, context) {
      if (!(await options.authorize(target, audience, context)))
        return fail('projection.permission', 'Public view access denied', 'permission');
      const loaded = await options.load(target, context);
      if (!loaded.ok) return loaded;
      const projector = options.projectors.get(
        `${loaded.value.type}@${loaded.value.schemaVersion}`,
      );
      if (!projector)
        return ok([
          {
            id: target.id,
            type: 'part/unknown',
            schemaVersion: 1,
            revision: audience.authorizationRevision,
            payload: null,
            fallback: { label: 'Unsupported item' },
            actions: [],
            artifacts: [],
          },
        ]);
      const projected = await projector.project(loaded.value.value, audience, context);
      if (!projected.ok) return projected;
      if (!isJson(projected.value))
        return fail('projection.wire', 'Projection must be lossless JSON');
      return ok(freeze(structuredClone(projected.value)));
    },
  };
}
