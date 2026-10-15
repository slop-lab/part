import { provenance } from '../context/index.js';
import { canonical, fail, freeze, isJson, ok } from '../foundation/contracts.js';
import type { Contracts, Storage, Workflows } from '../reference/index.js';
/** A storage port only. Each engine still owns checkpoint eligibility and scheduling. */
export function createCheckpointStore(
  store: Storage.StateJournalStore,
  namespace = 'part/workflow-checkpoints',
): Workflows.CheckpointStore {
  const address = (ref: Workflows.ExecutionRef): Storage.StateAddress => ({
    namespace,
    scope: { kind: 'runtime', id: ref.engine },
    key: canonical(ref as unknown as Contracts.Json),
  });
  return {
    async read(ref, context) {
      const loaded = await store.read(address(ref), context);
      if (!loaded.ok) return loaded;
      if (!loaded.value) return ok(null);
      const record = loaded.value.value.value as unknown as {
        principal: Contracts.InvocationContext['principal'];
        checkpoint: Workflows.Checkpoint;
      };
      if (canonical(record.principal) !== canonical(context.principal))
        return fail('checkpoint.permission', 'Checkpoint access denied', 'permission');
      return ok(freeze({ ...structuredClone(record.checkpoint), revision: loaded.value.revision }));
    },
    async commit(expectedRevision, checkpoint, context) {
      if (
        !isJson(checkpoint) ||
        checkpoint.engineVersion !== checkpoint.execution.engineVersion ||
        !checkpoint.definitionDigest ||
        !Number.isSafeInteger(checkpoint.stateSchema.version) ||
        checkpoint.completedCalls.some(
          (call) =>
            call.identity.workflow.id !== checkpoint.execution.id ||
            call.identity.workflow.engine !== checkpoint.execution.engine,
        )
      )
        return fail('checkpoint.input', 'Invalid checkpoint binding');
      const loaded = await store.read(address(checkpoint.execution), context);
      if (!loaded.ok) return loaded;
      if (
        loaded.value &&
        canonical(
          (
            loaded.value.value.value as unknown as {
              principal: Contracts.InvocationContext['principal'];
            }
          ).principal,
        ) !== canonical(context.principal)
      )
        return fail('checkpoint.permission', 'Checkpoint access denied', 'permission');
      const committed = await store.commit(
        {
          id: crypto.randomUUID(),
          mutations: [
            {
              address: address(checkpoint.execution),
              expected: expectedRevision,
              next: {
                schemaVersion: 1,
                value: { principal: context.principal, checkpoint } as unknown as Contracts.Json,
              },
            },
          ],
          append: [
            {
              id: crypto.randomUUID(),
              type: 'part.workflow/checkpoint',
              version: 1,
              payload: {
                execution: checkpoint.execution as unknown as Contracts.Json,
                definitionDigest: checkpoint.definitionDigest,
              },
              provenance,
            },
          ],
        },
        context,
      );
      return committed;
    },
  };
}
