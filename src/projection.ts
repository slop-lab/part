import type { Contracts as C, Projection as P } from './reference.js';
import { ok, fail, isJson, freeze } from './contracts.js';
export function createProjectionService(options: {
  authorize(
    target: C.EntityRef,
    audience: P.Audience,
    context: C.InvocationContext,
  ): Promise<boolean> | boolean;
  load(
    target: C.EntityRef,
    context: C.InvocationContext,
  ): Promise<C.Result<{ type: string; schemaVersion: number; value: unknown }>>;
  projectors: ReadonlyMap<string, P.Projector<unknown>>;
}): P.Service {
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
