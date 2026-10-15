/** @public */
import { canonical, emptyCleanup, fail, ok } from '../contracts/index.js';
import type { Contracts } from '../reference/contracts.js';
import type { Host } from '../reference/host.js';
export function createResourceManager(
  options: { closeGraceMs?: number } = {},
): Host.ResourceManager {
  const entries = new Map<
    string,
    {
      resource: Host.RuntimeResource;
      owner: Contracts.ScopeRef;
      closing?: Promise<Contracts.Result<void>>;
    }
  >();
  const key = (ref: Contracts.ResourceRef) => canonical(ref as unknown as Contracts.Json);
  return {
    register(resource) {
      const id = key(resource.ref);
      if (entries.has(id))
        return fail('resource.duplicate', 'Resource is already registered', 'conflict');
      entries.set(id, {
        resource: {
          ref: { ...resource.ref },
          owner: { ...resource.owner },
          transferable: resource.transferable,
          close: (reason) => resource.close(reason),
        },
        owner: { ...resource.owner },
      });
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
      const released: Contracts.EntityRef[] = [],
        unresolved: Contracts.EntityRef[] = [],
        errors: Contracts.Failure[] = [];
      await Promise.all(
        [...entries]
          .filter(
            ([, entry]) =>
              canonical(entry.owner as unknown as Contracts.Json) ===
              canonical(owner as unknown as Contracts.Json),
          )
          .map(async ([id, entry]) => {
            entry.closing ??= Promise.resolve()
              .then(() => entry.resource.close('owner-closed'))
              .catch(() => fail('resource.close', 'Resource close failed', 'internal'));
            let timer: ReturnType<typeof setTimeout> | undefined;
            const result = await Promise.race([
              entry.closing,
              new Promise<Contracts.Result<void>>((resolve) => {
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
