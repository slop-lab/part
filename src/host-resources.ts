import type { Contracts as C, Host as H } from './reference.js';
import { ok, fail, canonical, emptyCleanup } from './contracts.js';
export function createResourceManager(options: { closeGraceMs?: number } = {}): H.ResourceManager {
  const entries = new Map<
    string,
    { resource: H.RuntimeResource; owner: C.ScopeRef; closing?: Promise<C.Result<void>> }
  >();
  const key = (ref: C.ResourceRef) => canonical(ref as unknown as C.Json);
  return {
    register(resource) {
      const id = key(resource.ref);
      if (entries.has(id))
        return fail('resource.duplicate', 'Resource is already registered', 'conflict');
      entries.set(id, { resource, owner: { ...resource.owner } });
      return ok(Object.freeze({ ...resource.ref }));
    },
    transfer(ref, target) {
      const entry = entries.get(key(ref));
      if (!entry || entry.closing)
        return fail('resource.missing', 'Resource is missing or closing');
      if (!entry.resource.transferable)
        return fail('resource.transfer', 'Resource is not transferable', 'permission');
      entry.owner = { ...target };
      return ok(undefined);
    },
    async closeOwner(owner) {
      const report = emptyCleanup();
      const released: C.EntityRef[] = [],
        unresolved: C.EntityRef[] = [],
        errors: C.Failure[] = [];
      await Promise.all(
        [...entries]
          .filter(
            ([, entry]) =>
              canonical(entry.owner as unknown as C.Json) === canonical(owner as unknown as C.Json),
          )
          .map(async ([id, entry]) => {
            entry.closing ??= Promise.resolve()
              .then(() => entry.resource.close('owner-closed'))
              .catch(() => fail('resource.close', 'Resource close failed', 'internal'));
            let timer: ReturnType<typeof setTimeout> | undefined;
            const result = await Promise.race([
              entry.closing,
              new Promise<C.Result<void>>((resolve) => {
                timer = setTimeout(
                  () =>
                    resolve(
                      fail('resource.timeout', 'Resource close is unconfirmed', 'unavailable'),
                    ),
                  options.closeGraceMs ?? 1000,
                );
              }),
            ]);
            clearTimeout(timer);
            if (result.ok) {
              entries.delete(id);
              released.push({ ...entry.resource.ref });
            } else {
              unresolved.push({ ...entry.resource.ref });
              errors.push(result.error);
            }
          }),
      );
      return { ...report, released, unresolved, errors };
    },
  };
}
