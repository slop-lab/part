import { provenance } from '../context/index.js';
import { canonical, fail, isJson } from '../foundation/contracts.js';
import type { Contracts, Storage } from '../reference/index.js';
/** Explicit owner migration: data and successful schema publication commit atomically. */
export function createNamespaceMigrations(
  store: Storage.StateJournalStore,
  options: {
    namespace: string;
    owner: string;
    targetVersion: number;
    migrations: readonly Storage.Migration[];
    schema: Contracts.Schema<Contracts.Json>;
  },
): {
  migrate(
    addresses: readonly Storage.StateAddress[],
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Contracts.CommitEvidence>>;
  read(
    address: Storage.StateAddress,
    context: Contracts.InvocationContext,
  ): ReturnType<Storage.StateJournalStore['read']>;
} {
  const address: Storage.StateAddress = {
    namespace: 'part/migrations',
    scope: { kind: 'runtime', id: options.owner },
    key: options.namespace,
  };
  const migrations = new Map(options.migrations.map((m) => [m.from, m]));
  if (
    !Number.isSafeInteger(options.targetVersion) ||
    options.targetVersion < 1 ||
    migrations.size !== options.migrations.length ||
    options.migrations.some((m) => m.namespace !== options.namespace || m.to <= m.from)
  )
    throw new TypeError('Invalid namespace migration path');
  return {
    async read(target, context) {
      if (target.namespace !== options.namespace)
        return fail('migration.namespace', 'Address belongs to another namespace');
      const ledger = await store.read(address, context);
      if (!ledger.ok) return ledger;
      const data = ledger.value?.value.value as { status?: string; version?: number } | undefined;
      if (data?.status !== 'ready' || data.version !== options.targetVersion)
        return fail('migration.not-ready', 'New schema has not been published', 'conflict');
      const value = await store.read(target, context);
      if (!value.ok) return value;
      return !value.value || value.value.value.schemaVersion === options.targetVersion
        ? value
        : fail('migration.version', 'Record has not migrated to the active schema', 'conflict');
    },
    async migrate(addresses, context) {
      if (
        addresses.some((a) => a.namespace !== options.namespace) ||
        new Set(addresses.map((a) => canonical(a as unknown as Contracts.Json))).size !==
          addresses.length
      )
        return fail('migration.address', 'Invalid or duplicate migration address');
      const ledger = await store.read(address, context);
      if (!ledger.ok) return ledger;
      if ((ledger.value?.value.value as { status?: string })?.status === 'running')
        return fail(
          'migration.running',
          'A previous migration needs explicit reconciliation',
          'conflict',
        );
      const started = await store.commit(
        {
          id: crypto.randomUUID(),
          mutations: [
            {
              address,
              expected: ledger.value?.revision ?? 'absent',
              next: {
                schemaVersion: 1,
                value: { status: 'running', owner: options.owner, version: options.targetVersion },
              },
            },
          ],
          append: [],
        },
        context,
      );
      if (!started.ok) return started;
      const running = await store.read(address, context);
      if (!running.ok || !running.value)
        return fail('migration.ledger', 'Migration ledger unavailable');
      try {
        const mutations: Storage.Mutation[] = [];
        for (const target of addresses) {
          const loaded = await store.read(target, context);
          if (!loaded.ok) throw loaded.error;
          if (!loaded.value) continue;
          let version = loaded.value.value.schemaVersion,
            value = structuredClone(loaded.value.value.value);
          while (version < options.targetVersion) {
            const migration = migrations.get(version);
            if (!migration || migration.to > options.targetVersion)
              throw fail('migration.path', 'Migration path is missing').error;
            const transformed = migration.transform(value);
            if (!transformed.ok || !isJson(transformed.value))
              throw fail('migration.transform', 'Migration transformation failed').error;
            value = transformed.value;
            version = migration.to;
          }
          if (version !== options.targetVersion || !options.schema.validate(value).ok)
            throw fail('migration.schema', 'Migrated data fails the target schema').error;
          mutations.push({
            address: target,
            expected: loaded.value.revision,
            next: { schemaVersion: version, value },
          });
        }
        mutations.push({
          address,
          expected: running.value.revision,
          next: {
            schemaVersion: 1,
            value: { status: 'ready', owner: options.owner, version: options.targetVersion },
          },
        });
        const committed = await store.commit(
          {
            id: crypto.randomUUID(),
            mutations,
            append: [
              {
                id: crypto.randomUUID(),
                type: 'part.storage/migrated',
                version: 1,
                payload: {
                  namespace: options.namespace,
                  owner: options.owner,
                  version: options.targetVersion,
                },
                provenance,
              },
            ],
          },
          context,
        );
        if (!committed.ok) throw committed.error;
        return committed;
      } catch {
        await store.commit(
          {
            id: crypto.randomUUID(),
            mutations: [
              {
                address,
                expected: running.value.revision,
                next: {
                  schemaVersion: 1,
                  value: { status: 'failed', owner: options.owner, version: options.targetVersion },
                },
              },
            ],
            append: [],
          },
          { ...context, signal: new AbortController().signal },
        );
        return fail(
          'migration.failed',
          'Migration failed; original schema data remains intact',
          'conflict',
        );
      }
    },
  };
}
