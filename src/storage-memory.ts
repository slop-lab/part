import type { Contracts, Storage } from './reference.js';
import { ok, fail, canonical, isJson } from './contracts.js';
export interface StoreData {
  revision: number;
  state: Record<string, Contracts.Versioned<Storage.StateValue>>;
  journal: Storage.JournalEntry[];
  changes: Record<string, { digest: string; receipt: Storage.CommitReceipt }>;
  commands: Record<string, { requestDigest: string; receipt: Contracts.Json }>;
}
export const initialStoreData = (): StoreData => ({
  revision: 0,
  state: {},
  journal: [],
  changes: {},
  commands: {},
});
export const addressKey = (address: Storage.StateAddress) =>
  canonical({ namespace: address.namespace, scope: { ...address.scope }, key: address.key });
export function applyChanges(
  data: StoreData,
  changes: Storage.ChangeSet,
  id: string,
  durability: Contracts.CommitEvidence['durability'],
): Contracts.Result<{ data: StoreData; receipt: Storage.CommitReceipt }> {
  if (
    !isJson(changes) ||
    !changes.id ||
    !Array.isArray(changes.mutations) ||
    !Array.isArray(changes.append)
  )
    return fail('storage.changes', 'Invalid change set');
  const encoded = canonical(changes as unknown as Contracts.Json),
    existing = Object.hasOwn(data.changes, changes.id) ? data.changes[changes.id] : undefined;
  if (existing)
    return existing.digest === encoded
      ? ok({ data, receipt: structuredClone(existing.receipt) })
      : fail('storage.change-id', 'Change ID has different content', 'conflict');
  if (data.revision >= Number.MAX_SAFE_INTEGER)
    return fail('storage.revision', 'Store revision space exhausted', 'conflict');
  if (changes.commandReceipt) {
    const old = Object.hasOwn(data.commands, changes.commandReceipt.key)
      ? data.commands[changes.commandReceipt.key]
      : undefined;
    if (old)
      return fail(
        'storage.command-key',
        old.requestDigest === changes.commandReceipt.requestDigest
          ? 'Command already committed; query its receipt'
          : 'Command key has different content',
        'conflict',
      );
  }
  const keys = new Set<string>();
  for (const mutation of changes.mutations) {
    if (
      !mutation.address.namespace ||
      !mutation.address.key ||
      !mutation.address.scope.id ||
      !mutation.address.scope.kind
    )
      return fail('storage.address', 'Invalid state address');
    const key = addressKey(mutation.address);
    if (keys.has(key)) return fail('storage.duplicate-mutation', 'Duplicate mutation address');
    keys.add(key);
    const current = data.state[key];
    if (mutation.expected === 'absent' ? !!current : current?.revision !== mutation.expected)
      return fail('storage.revision', 'Expected state revision does not match', 'conflict');
    if (
      mutation.next &&
      (!Number.isSafeInteger(mutation.next.schemaVersion) || mutation.next.schemaVersion < 1)
    )
      return fail('storage.schema', 'Invalid state schema version');
  }
  const journalIds = new Set(data.journal.map((entry) => entry.id));
  for (const entry of changes.append) {
    if (!entry.id || journalIds.has(entry.id))
      return fail('storage.journal-id', 'Duplicate journal ID', 'conflict');
    journalIds.add(entry.id);
  }
  const next = structuredClone(data),
    revision = String(++next.revision);
  for (const mutation of changes.mutations) {
    const key = addressKey(mutation.address);
    if (mutation.next)
      Object.defineProperty(next.state, key, {
        value: { revision, value: structuredClone(mutation.next) },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else delete next.state[key];
  }
  next.journal.push(...structuredClone(changes.append));
  const receipt: Storage.CommitReceipt = {
    owner: id,
    revision,
    durability,
    transactionId: changes.id,
    appended: changes.append.map((entry) => entry.id),
    publicationWatermark: String(next.journal.length),
  };
  Object.defineProperty(next.changes, changes.id, {
    value: { digest: encoded, receipt },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  if (changes.commandReceipt)
    Object.defineProperty(next.commands, changes.commandReceipt.key, {
      value: structuredClone(changes.commandReceipt),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return ok({ data: next, receipt: structuredClone(receipt) });
}
export interface LocalStore extends Storage.StateJournalStore {
  close(): void;
  commandReceipt(
    key: string,
  ): Promise<Contracts.Result<{ requestDigest: string; receipt: Contracts.Json } | null>>;
}
export function storeFacade(
  id: string,
  durability: 'memory' | 'durable',
  access: <T>(
    write: boolean,
    action: (data: StoreData) => Contracts.Result<{ data: StoreData; value: T }>,
  ) => Contracts.Result<T>,
  close: () => void,
): LocalStore {
  return {
    id,
    capabilities: {
      history: durability,
      atomicStateJournal: true,
      durableWaits: false,
      resumableHandlers: [],
      artifactFinalization: false,
      commandDedupe: { scope: 'store-lifetime', retentionMs: Number.MAX_SAFE_INTEGER },
    },
    close,
    async read(address, context) {
      if (context.signal.aborted) return fail('storage.cancelled', 'Read cancelled', 'cancelled');
      return access(false, (data) =>
        ok({ data, value: structuredClone(data.state[addressKey(address)] ?? null) }),
      );
    },
    async commit(changes, context) {
      if (context.signal.aborted) return fail('storage.cancelled', 'Commit cancelled', 'cancelled');
      return access(true, (data) => {
        const applied = applyChanges(data, changes, id, durability);
        return applied.ok
          ? ok({ data: applied.value.data, value: applied.value.receipt })
          : applied;
      });
    },
    async journal(cursor, limit, context) {
      if (context.signal.aborted)
        return fail('storage.cancelled', 'Journal read cancelled', 'cancelled');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        return fail('storage.limit', 'Journal limit must be 1..1000');
      const prefix = `${id}:`,
        offset = cursor?.startsWith(prefix)
          ? Number(cursor.slice(prefix.length))
          : cursor === undefined
            ? 0
            : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0)
        return fail('storage.cursor', 'Invalid journal cursor');
      return access(false, (data) => {
        if (offset > data.journal.length)
          return fail('storage.cursor', 'Cursor is ahead of journal');
        const end = Math.min(offset + limit, data.journal.length);
        return ok({
          data,
          value: {
            items: structuredClone(data.journal.slice(offset, end)),
            ...(end < data.journal.length ? { nextCursor: `${prefix}${end}` } : {}),
          },
        });
      });
    },
    async commandReceipt(key) {
      return access(false, (data) =>
        ok({
          data,
          value: structuredClone(Object.hasOwn(data.commands, key) ? data.commands[key]! : null),
        }),
      );
    },
  };
}
export function createMemoryStore(id = `part/memory/${crypto.randomUUID()}`): LocalStore {
  let data = initialStoreData(),
    closed = false;
  return storeFacade(
    id,
    'memory',
    (_write, action) => {
      if (closed) return fail('storage.closed', 'Store is closed', 'conflict');
      const result = action(data);
      if (!result.ok) return result;
      data = result.value.data;
      return ok(result.value.value);
    },
    () => {
      closed = true;
    },
  );
}
