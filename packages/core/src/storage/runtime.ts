import { provenance } from '../context/index.js';
import { fail, ok } from '../contracts/index.js';
import type { Contracts } from '../reference/contracts.js';
import type { Runtime } from '../reference/runtime.js';
import type { Storage } from '../reference/storage.js';
import { createBoundary } from '../runtime/boundary.js';
export function createStoredBoundary(
  store: Storage.StateJournalStore,
  namespace = 'part/execution',
): Runtime.InvocationBoundary {
  const address = (plan: Runtime.EffectPlan): Storage.StateAddress => ({
    namespace,
    scope: { kind: 'operation', id: plan.operationId },
    key: plan.attemptId,
  });
  return createBoundary({
    async prepare(plan, context) {
      const commit = await store.commit(
        {
          id: `intent/${plan.attemptId}`,
          mutations: [
            {
              address: address(plan),
              expected: 'absent',
              next: {
                schemaVersion: 1,
                value: {
                  plan: plan as unknown as Contracts.Json,
                  phase: 'running',
                  effect: 'not-attempted',
                },
              },
            },
          ],
          append: [
            {
              id: `intent/${plan.attemptId}`,
              type: 'part.execution/intent',
              version: 1,
              payload: { plan: plan as unknown as Contracts.Json, namespace },
              provenance,
            },
          ],
        },
        context,
      );
      return commit.ok ? ok(undefined) : commit;
    },
    async settle(plan, outcome, context) {
      // Cancellation must still permit recording the already-attempted effect.
      const settling = { ...context, signal: new AbortController().signal };
      const current = await store.read(address(plan), settling);
      if (!current.ok) return current;
      if (!current.value) return fail('execution.intent', 'Intent missing', 'conflict');
      const committed = await store.commit(
        {
          id: `settle/${plan.attemptId}`,
          mutations: [
            {
              address: address(plan),
              expected: current.value.revision,
              next: {
                schemaVersion: 1,
                value: {
                  plan: plan as unknown as Contracts.Json,
                  phase:
                    outcome.kind === 'returned'
                      ? 'completed'
                      : outcome.kind === 'cancelled'
                        ? 'cancelled'
                        : 'failed',
                  effect: outcome.effect,
                },
              },
            },
          ],
          append: [
            {
              id: `settle/${plan.attemptId}`,
              type: 'part.execution/settled',
              version: 1,
              payload: {
                attemptId: plan.attemptId,
                operationId: plan.operationId,
                effect: outcome.effect,
                outcome: outcome.kind,
              },
              provenance,
            },
          ],
        },
        settling,
      );
      return committed.ok ? ok([committed.value]) : committed;
    },
  });
}
export function createExecutionRecovery(store: Storage.StateJournalStore): Storage.RecoveryAdapter {
  return {
    async recover(context) {
      const intents: { plan: Runtime.EffectPlan; namespace: string }[] = [],
        settled = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await store.journal(cursor, 1000, context);
        if (!page.ok) return page;
        for (const entry of page.value.items) {
          if (entry.type === 'part.execution/intent')
            intents.push(
              entry.payload as unknown as { plan: Runtime.EffectPlan; namespace: string },
            );
          if (entry.type === 'part.execution/settled')
            settled.add((entry.payload as { attemptId: string }).attemptId);
        }
        cursor = page.value.nextCursor;
      } while (cursor);
      const abandoned: Contracts.EntityRef[] = [],
        reconciliationRequired: Contracts.EntityRef[] = [],
        errors: Contracts.Failure[] = [];
      for (const { plan, namespace } of intents) {
        if (settled.has(plan.attemptId)) continue;
        const address = {
          namespace,
          scope: { kind: 'operation', id: plan.operationId },
          key: plan.attemptId,
        };
        const current = await store.read(address, context);
        if (!current.ok) {
          errors.push(current.error);
          continue;
        }
        if (!current.value) continue;
        const ref = { owner: 'part/operations', kind: 'part/operation', id: plan.operationId };
        const committed = await store.commit(
          {
            id: `recover/${plan.attemptId}/${current.value.revision}`,
            mutations: [
              {
                address,
                expected: current.value.revision,
                next: {
                  schemaVersion: 1,
                  value: {
                    plan: plan as unknown as Contracts.Json,
                    phase: 'abandoned',
                    effect: 'unknown',
                  },
                },
              },
            ],
            append: [],
          },
          context,
        );
        if (!committed.ok) {
          errors.push(committed.error);
          continue;
        }
        abandoned.push(ref);
        if (plan.classification !== 'read') reconciliationRequired.push(ref);
      }
      return ok({ recovered: [], abandoned, reconciliationRequired, errors });
    },
  };
}
