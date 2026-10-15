import { emptyCleanup, fail, localContext, ok } from '../contracts/index.js';
import type { Composition } from '../reference/composition.js';
import type { Contracts } from '../reference/contracts.js';

import { plans } from './handles.js';
export function createScopeManager(
  options: { context?: Partial<Contracts.InvocationContext> } = {},
): Composition.ScopeManager {
  return {
    async open(scope, composition) {
      const plan =
        typeof composition.localToken === 'object' && composition.localToken !== null
          ? plans.get(composition.localToken)
          : undefined;
      if (!plan || composition.inspection !== plan.inspection)
        return fail('composition.handle', 'Unknown or modified composition handle');
      const values = new Map<string, unknown>(),
        cleanup: (() => Promise<Contracts.CleanupReport>)[] = [];
      let closing: Promise<Contracts.CleanupReport> | undefined,
        closed = false;
      const services: Contracts.ServiceAccess = {
        get(key) {
          const point = plan.points.get(key.id);
          if (
            closed ||
            !point ||
            key.scope !== scope.kind ||
            point.scope !== key.scope ||
            point.contractVersion !== key.contractVersion ||
            !values.has(key.id)
          )
            return fail('service.missing', key.id, 'unsupported');
          return ok(values.get(key.id) as never);
        },
      };
      const context = localContext({ ...options.context, scope, services });
      const failureWithCleanup = (
        error: Contracts.Failure,
        cleanup: Contracts.CleanupReport,
      ): Contracts.Result<never> => ({
        ok: false,
        error: {
          ...error,
          details: {
            cleanup: cleanup as unknown as Contracts.Json,
            originalDetails: error.details ?? null,
          },
        },
      });
      const close = (): Promise<Contracts.CleanupReport> =>
        (closing ??= (async () => {
          closed = true;
          const reports: Contracts.CleanupReport[] = [];
          for (const dispose of cleanup.reverse()) {
            try {
              reports.push(await dispose());
            } catch {
              reports.push({
                ...emptyCleanup(),
                errors: [
                  {
                    code: 'part.cleanup',
                    category: 'internal',
                    message: 'Cleanup failed',
                    retry: 'never',
                  },
                ],
              });
            }
          }
          values.clear();
          return {
            released: reports.flatMap((r) => r.released),
            unresolved: reports.flatMap((r) => r.unresolved),
            errors: reports.flatMap((r) => r.errors),
          };
        })());
      try {
        for (const [id, point] of plan.points) {
          if (point.scope === scope.kind && point.kind === 'pipeline' && !plan.bindings.has(id))
            values.set(id, Object.freeze([]));
        }
        for (const [id, list] of plan.bindings) {
          const point = plan.points.get(id)!;
          if (point.scope !== scope.kind) continue;
          values.set(
            id,
            point.kind === 'service'
              ? list[0]?.value
              : point.kind === 'registry'
                ? readonlyMap(new Map(list.map((b) => [b.key!, b.value])))
                : Object.freeze(list.map((b) => b.value)),
          );
        }
        for (const id of plan.factoryOrder) {
          const factory = plan.factories.get(id)!;
          if (factory.scope !== scope.kind) continue;
          const created = await factory.create(plan.config, context);
          if (!created.ok) {
            const report = await close();
            return {
              ok: false,
              error: {
                ...created.error,
                details: { cleanup: report as unknown as Contracts.Json },
              },
            };
          }
          values.set(id, created.value.value);
          cleanup.push(() => created.value.dispose());
        }
        for (const component of plan.components) {
          if (component.descriptor.scope !== scope.kind) continue;
          const created = component.create(plan.config, services);
          if (!created.ok) {
            return failureWithCleanup(created.error, await close());
          }
          const instance = created.value;
          cleanup.push(() => instance.dispose());
          const initialized = await instance.initialize(context);
          if (!initialized.ok) {
            return failureWithCleanup(initialized.error, await close());
          }
          cleanup.push(() => instance.stop('scope-close'));
          const started = await instance.start(context);
          if (!started.ok) {
            return failureWithCleanup(started.error, await close());
          }
        }
        return ok({ scope, services, close });
      } catch {
        const report = await close();
        return failureWithCleanup(
          fail(
            'scope.open',
            `Scope initialization failed (${report.errors.length} cleanup errors)`,
            'internal',
          ).error,
          report,
        );
      }
    },
  };
}

function readonlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  return Object.freeze({
    get size() {
      return map.size;
    },
    has: (key: K) => map.has(key),
    get: (key: K) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map.entries(),
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      const view = this;
      map.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
  });
}
