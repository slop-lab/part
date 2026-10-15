import type { Contracts, History, Storage } from './reference.js';
import { ok, fail, isJson, isJsonObject } from './contracts.js';
import { createMemoryStore } from './storage-memory.js';
import { provenance } from './context.js';
interface SessionData {
  metadata: Contracts.Json;
  principal: Contracts.InvocationContext['principal'];
}
interface BranchData {
  sessionId: string;
  head?: string;
}
export interface HistoryService extends History.Service {
  readonly owner: string;
  readonly durability: 'memory' | 'durable';
  getBranch(
    id: string,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<History.Branch>>;
}
export function createHistory(
  options: { store?: Storage.StateJournalStore; namespace?: string } = {},
): HistoryService {
  const store = options.store ?? createMemoryStore(),
    namespace = options.namespace ?? 'part/history';
  const address = (kind: string, id: string): Storage.StateAddress => ({
    namespace,
    scope: { kind: 'history', id: namespace },
    key: `${kind}/${id}`,
  });
  const authorize = async (
    sessionId: string,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<void>> => {
    const session = await store.read(address('session', sessionId), context);
    if (!session.ok) return session;
    if (!session.value) return fail('history.session', 'Session not found');
    const data = session.value.value.value as unknown as SessionData;
    return context.principal.subject === data.principal.subject &&
      context.principal.authority === data.principal.authority
      ? ok(undefined)
      : fail('history.permission', 'Session access denied', 'permission');
  };
  const getBranch = async (
    id: string,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<History.Branch>> => {
    const found = await store.read(address('branch', id), context);
    if (!found.ok) return found;
    if (!found.value) return fail('history.branch', 'Branch not found');
    const data = found.value.value.value as unknown as BranchData;
    const allowed = await authorize(data.sessionId, context);
    if (!allowed.ok) return allowed;
    return ok({ id, ...data, revision: found.value.revision });
  };
  const path = async (
    branch: History.Branch,
    cursor: string | undefined,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Contracts.Page<History.Entry>>> => {
    const current = await getBranch(branch.id, context);
    if (!current.ok) return current;
    if (current.value.sessionId !== branch.sessionId)
      return fail('history.session', 'Branch session mismatch');
    const entries: History.Entry[] = [],
      seen = new Set<string>();
    let id = branch.head;
    while (id) {
      if (seen.has(id)) return fail('history.cycle', 'Corrupt history chain');
      seen.add(id);
      const found = await store.read(address('entry', id), context);
      if (!found.ok) return found;
      if (!found.value) return fail('history.entry', 'History entry missing');
      const data = found.value.value.value as unknown as {
        entry: History.Entry;
        sessionId: string;
      };
      if (data.sessionId !== branch.sessionId)
        return fail('history.permission', 'Entry belongs to another session', 'permission');
      entries.push(data.entry);
      id = data.entry.previous;
    }
    entries.reverse();
    const offset = cursor ? entries.findIndex((e) => e.entryId === cursor) + 1 : 0;
    if (cursor && offset === 0) return fail('history.cursor', 'Unknown history cursor');
    return ok({ items: structuredClone(entries.slice(offset)) });
  };
  return {
    owner: namespace,
    durability: store.capabilities.history,
    getBranch,
    path,
    async createSession(metadata, context) {
      if (!isJson(metadata)) return fail('history.metadata', 'Invalid session metadata');
      const id = crypto.randomUUID(),
        principal = { ...context.principal };
      const changes: Storage.ChangeSet = {
        id: crypto.randomUUID(),
        mutations: [
          {
            address: address('session', id),
            expected: 'absent',
            next: { schemaVersion: 1, value: { metadata, principal } },
          },
          {
            address: address('branch', id),
            expected: 'absent',
            next: { schemaVersion: 1, value: { sessionId: id } },
          },
        ],
        append: [],
      };
      const committed = await store.commit(changes, context);
      return committed.ok ? ok({ owner: namespace, kind: 'part/session', id }) : committed;
    },
    async append(branch, records, context) {
      const current = await getBranch(branch.id, context);
      if (!current.ok) return current;
      if (
        current.value.revision !== branch.revision ||
        current.value.head !== branch.head ||
        current.value.sessionId !== branch.sessionId
      )
        return fail('history.revision', 'Branch head/revision mismatch', 'conflict');
      const mutations: Storage.Mutation[] = [],
        append: Storage.JournalEntry[] = [];
      const ids = new Set<string>();
      let head = branch.head;
      for (const record of records) {
        if (
          !isJson(record) ||
          !record.id ||
          ids.has(record.id) ||
          !Number.isSafeInteger(record.schemaVersion) ||
          record.schemaVersion < 1
        )
          return fail('history.record', 'Invalid or duplicate record');
        ids.add(record.id);
        const entry: History.Entry = {
          entryId: crypto.randomUUID(),
          ...(head ? { previous: head } : {}),
          record: structuredClone(record),
        };
        head = entry.entryId;
        mutations.push(
          {
            address: address('record', record.id),
            expected: 'absent',
            next: { schemaVersion: 1, value: record as unknown as Contracts.Json },
          },
          {
            address: address('entry', head),
            expected: 'absent',
            next: {
              schemaVersion: 1,
              value: { sessionId: branch.sessionId, entry: entry as unknown as Contracts.Json },
            },
          },
        );
        append.push({
          id: entry.entryId,
          type: 'part.history/append',
          version: 1,
          payload: entry as unknown as Contracts.Json,
          provenance,
        });
      }
      mutations.push({
        address: address('branch', branch.id),
        expected: branch.revision,
        next: {
          schemaVersion: 1,
          value: { sessionId: branch.sessionId, ...(head ? { head } : {}) },
        },
      });
      const committed = await store.commit({ id: crypto.randomUUID(), mutations, append }, context);
      return committed.ok
        ? ok({ ...branch, ...(head ? { head } : {}), revision: committed.value.revision })
        : committed;
    },
    async fork(branch, atEntry, context) {
      const entries = await path(branch, undefined, context);
      if (!entries.ok) return entries;
      if (atEntry && !entries.value.items.some((entry) => entry.entryId === atEntry))
        return fail('history.fork', 'Fork entry is not on this branch');
      const id = crypto.randomUUID(),
        data = { sessionId: branch.sessionId, ...(atEntry ? { head: atEntry } : {}) };
      const result = await store.commit(
        {
          id: crypto.randomUUID(),
          mutations: [
            {
              address: address('branch', id),
              expected: 'absent',
              next: { schemaVersion: 1, value: data },
            },
          ],
          append: [],
        },
        context,
      );
      return result.ok ? ok({ id, ...data, revision: result.value.revision }) : result;
    },
  };
}
