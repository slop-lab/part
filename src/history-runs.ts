import type { Contracts, Runtime, History, Model, Context } from './reference.js';
import type { HistoryService } from './history.js';
import { ok, fail, canonical, isJson } from './contracts.js';
import { semanticItem, messageItem, provenance } from './context.js';
export interface RunHistoryLease {
  readonly input: unknown;
  finish(
    outcome: Runtime.ManagedOutcome<unknown>,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<readonly Contracts.CommitEvidence[]>>;
  release(): void;
}
export interface RunHistoryAttachment {
  prepare(
    selection: NonNullable<Runtime.RunRequest<unknown>['history']>,
    input: unknown,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<RunHistoryLease>>;
}
export function createHistoryAttachment(options: {
  history: HistoryService;
  input(records: readonly History.Record[], input: unknown): Promise<Contracts.Result<unknown>>;
  records(
    input: unknown,
    outcome: Runtime.ManagedOutcome<unknown>,
  ): Promise<Contracts.Result<readonly History.Record[]>>;
}): RunHistoryAttachment {
  const writers = new Set<string>();
  return {
    async prepare(selection, input, context) {
      const key = canonical({ session: selection.sessionId, branch: selection.branchId });
      if (writers.has(key))
        return fail('history.writer', 'Branch already has an active run writer', 'conflict');
      writers.add(key);
      const release = () => {
        writers.delete(key);
      };
      try {
        const branch = await options.history.getBranch(selection.branchId, context);
        if (!branch.ok) {
          release();
          return branch;
        }
        if (
          branch.value.sessionId !== selection.sessionId ||
          branch.value.head !== selection.expectedHead
        ) {
          release();
          return fail('history.head', 'Run history selection is stale', 'conflict');
        }
        const path = await options.history.path(branch.value, undefined, context);
        if (!path.ok) {
          release();
          return path;
        }
        const prepared = await options.input(
          path.value.items.map((entry) => entry.record).filter((record) => record.visibility.model),
          input,
        );
        if (!prepared.ok) {
          release();
          return prepared;
        }
        let finished = false;
        return ok({
          input: prepared.value,
          release,
          async finish(outcome, caller) {
            if (finished)
              return fail('history.finish', 'History lease already settled', 'conflict');
            finished = true;
            try {
              const records = await options.records(input, outcome);
              if (!records.ok) return records;
              // Terminal evidence must be recorded even after execution cancellation.
              const committed = await options.history.append(branch.value, records.value, {
                ...caller,
                signal: new AbortController().signal,
              });
              return committed.ok
                ? ok([
                    {
                      owner: options.history.owner,
                      revision: committed.value.revision,
                      durability: options.history.durability,
                    },
                  ])
                : committed;
            } finally {
              release();
            }
          },
        });
      } catch {
        release();
        return fail('history.attachment', 'History attachment failed', 'internal');
      }
    },
  };
}
/** Chat history is opt-in and translates immutable records through public semantic items. */
export function createChatHistoryAttachment(history: HistoryService): RunHistoryAttachment {
  const record = (item: Context.SemanticItem): History.Record => ({
    id: crypto.randomUUID(),
    type: item.type,
    schemaVersion: item.schemaVersion,
    payload: item.payload as Contracts.Json,
    provenance: item.provenance,
    visibility: { model: true, conversation: true, inspector: true, export: true },
    createdAt: new Date().toISOString(),
  });
  return createHistoryAttachment({
    history,
    async input(records, input) {
      const messages = await Promise.all(
        records.map((r) => semanticItem(r.type, r.payload, r.id, r.schemaVersion)),
      );
      const incoming =
        typeof input === 'string'
          ? [await messageItem('user', [{ kind: 'text', text: input }])]
          : Array.isArray(input)
            ? input
            : undefined;
      return incoming
        ? ok([...messages, ...incoming])
        : fail('history.input', 'Chat history requires text or semantic items');
    },
    async records(input, outcome) {
      const items =
        typeof input === 'string'
          ? [await messageItem('user', [{ kind: 'text', text: input }])]
          : Array.isArray(input)
            ? (input as Context.SemanticItem[])
            : [];
      const records = items.map(record);
      if (outcome.phase === 'completed') {
        const response = outcome.result as Model.Response;
        if (!isJson(response) || !Array.isArray(response.content))
          return fail('history.response', 'Chat response is not model content');
        records.push(record(await messageItem('assistant', response.content)));
      } else
        records.push({
          id: crypto.randomUUID(),
          type: 'part/run-terminal',
          schemaVersion: 1,
          payload: { phase: outcome.phase, effect: outcome.effect },
          provenance,
          visibility: { model: false, conversation: true, inspector: true, export: true },
          createdAt: new Date().toISOString(),
        });
      return ok(records);
    },
  });
}
