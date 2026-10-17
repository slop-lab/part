import { costUnits } from '@slop-lab/part/runtime/costs.js';
import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Projection, Runtime, Workflows } from '@slop-lab/part/reference/index.js';

const numericKeys = [
  'maxModelInvocations',
  'maxToolDispatches',
  'maxExecutorAttempts',
  'maxChildRuns',
  'maxConcurrentOperations',
  'maxKnownTokens',
] as const;
const allowedKeys = new Set<string>([...numericKeys, 'estimatedCostCeiling', 'deadline']);

function parseLimits(value: unknown): Contracts.Result<Runtime.ExecutionLimits> {
  if (value === undefined) return ok({});
  if (!isJsonObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key)))
    return fail('workflow.limits', 'Invalid or uninstalled workflow limit');
  for (const key of numericKeys) {
    const selected = value[key];
    if (
      selected !== undefined &&
      (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < 0)
    )
      return fail('workflow.limits', `Invalid workflow limit: ${key}`);
  }
  const cost = value.estimatedCostCeiling;
  if (
    cost !== undefined &&
    (!isJsonObject(cost) ||
      Object.keys(cost).some((key) => !['amount', 'currency'].includes(key)) ||
      typeof cost.amount !== 'string' ||
      typeof cost.currency !== 'string' ||
      !costUnits(cost.amount).ok ||
      !/^[A-Z]{3}$/.test(cost.currency))
  )
    return fail('workflow.limits', 'Invalid workflow estimated cost ceiling');
  if (
    value.deadline !== undefined &&
    (typeof value.deadline !== 'string' || Number.isNaN(Date.parse(value.deadline)))
  )
    return fail('workflow.limits', 'Invalid workflow deadline');
  return ok({
    ...(typeof value.maxModelInvocations === 'number'
      ? { maxModelInvocations: value.maxModelInvocations }
      : {}),
    ...(typeof value.maxToolDispatches === 'number'
      ? { maxToolDispatches: value.maxToolDispatches }
      : {}),
    ...(typeof value.maxExecutorAttempts === 'number'
      ? { maxExecutorAttempts: value.maxExecutorAttempts }
      : {}),
    ...(typeof value.maxChildRuns === 'number' ? { maxChildRuns: value.maxChildRuns } : {}),
    ...(typeof value.maxConcurrentOperations === 'number'
      ? { maxConcurrentOperations: value.maxConcurrentOperations }
      : {}),
    ...(typeof value.maxKnownTokens === 'number' ? { maxKnownTokens: value.maxKnownTokens } : {}),
    ...(isJsonObject(cost) && typeof cost.amount === 'string' && typeof cost.currency === 'string'
      ? { estimatedCostCeiling: { amount: cost.amount, currency: cost.currency } }
      : {}),
    ...(typeof value.deadline === 'string' ? { deadline: value.deadline } : {}),
  });
}

const stricter = (host: number | undefined, client: number | undefined) =>
  host === undefined ? client : client === undefined ? host : Math.min(host, client);

export function mergeExecutionLimits(
  hostValue: unknown,
  clientValue: unknown,
): Contracts.Result<Runtime.ExecutionLimits | undefined> {
  const host = parseLimits(hostValue);
  if (!host.ok) return host;
  const client = parseLimits(clientValue);
  if (!client.ok) return client;
  const hostCost = host.value.estimatedCostCeiling;
  const clientCost = client.value.estimatedCostCeiling;
  if (hostCost && clientCost && hostCost.currency !== clientCost.currency)
    return fail('workflow.limits', 'Client cost ceiling currency differs from host ceiling');
  const hostCostUnits = hostCost ? costUnits(hostCost.amount) : undefined;
  const clientCostUnits = clientCost ? costUnits(clientCost.amount) : undefined;
  const cost =
    hostCost && clientCost
      ? hostCostUnits?.ok && clientCostUnits?.ok && hostCostUnits.value <= clientCostUnits.value
        ? hostCost
        : clientCost
      : (hostCost ?? clientCost);
  const deadline =
    host.value.deadline && client.value.deadline
      ? Date.parse(host.value.deadline) <= Date.parse(client.value.deadline)
        ? host.value.deadline
        : client.value.deadline
      : (host.value.deadline ?? client.value.deadline);
  const merged: Runtime.ExecutionLimits = {
    ...Object.fromEntries(
      numericKeys.flatMap((key) => {
        const value = stricter(host.value[key], client.value[key]);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
    ...(cost ? { estimatedCostCeiling: cost } : {}),
    ...(deadline ? { deadline } : {}),
  };
  return ok(Object.keys(merged).length ? merged : undefined);
}

export function isWorkflowSettled(snapshot: Workflows.Snapshot): boolean {
  return (
    ['succeeded', 'failed', 'cancelled'].includes(snapshot.phase) &&
    snapshot.activeOperations.length === 0
  );
}

export function createSettlementTracker(): {
  notify(snapshot: Workflows.Snapshot): void;
  wait(
    entry: { readonly ref: Workflows.ExecutionRef; readonly engine: Workflows.Engine },
    context: Contracts.InvocationContext,
    timeoutMs: number,
  ): Promise<void>;
} {
  const waiters = new Map<string, Set<() => void>>();
  return {
    notify(snapshot) {
      if (!isWorkflowSettled(snapshot)) return;
      for (const settle of waiters.get(snapshot.ref.id) ?? []) settle();
      waiters.delete(snapshot.ref.id);
    },
    async wait(entry, context, timeoutMs) {
      const pending = waiters.get(entry.ref.id) ?? new Set<() => void>();
      let settle = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
        pending.add(settle);
        waiters.set(entry.ref.id, pending);
        AbortSignal.timeout(timeoutMs).addEventListener('abort', () => resolve(), { once: true });
      });
      const before = await entry.engine.get(entry.ref, context);
      if (!before.ok || isWorkflowSettled(before.value)) settle();
      await settled;
      pending.delete(settle);
      if (!pending.size) waiters.delete(entry.ref.id);
    },
  };
}

export function withCancelAction(
  snapshot: Workflows.Snapshot,
  item: Projection.Item,
): Projection.Item {
  if (isWorkflowSettled(snapshot)) return item;
  return {
    ...item,
    actions: [
      ...item.actions.filter((action) => action.id !== 'part.workflow/cancel'),
      {
        id: 'part.workflow/cancel',
        version: 1,
        input: { id: 'part/null', version: 1 },
        output: { id: 'part/json', version: 1 },
        execution: 'immediate',
        availability: { state: 'available', checkedAt: snapshot.revision },
      },
    ],
  };
}

export async function boundedClose<T>(
  pending: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeWorkflowExecutions(options: {
  readonly entries: readonly {
    readonly ref: Workflows.ExecutionRef;
    readonly engine: Workflows.Engine;
  }[];
  readonly context: Contracts.InvocationContext;
  readonly timeoutMs: number;
  readonly wait: (entry: {
    readonly ref: Workflows.ExecutionRef;
    readonly engine: Workflows.Engine;
  }) => Promise<void>;
}): Promise<Contracts.CleanupReport> {
  const errors: Contracts.Failure[] = [],
    released: Contracts.EntityRef[] = [],
    unresolved: Contracts.EntityRef[] = [];
  await Promise.all(
    options.entries.map(async (entry) => {
      const ref = { owner: entry.ref.engine, kind: 'part/workflow', id: entry.ref.id };
      try {
        const cancellation = await boundedClose(
          entry.engine.requestCancel(entry.ref, 'endpoint-closed', options.context),
          options.timeoutMs,
        );
        if (cancellation && !cancellation.ok) errors.push(cancellation.error);
        if (!cancellation) {
          unresolved.push(ref);
          errors.push(
            fail(
              'workflow.cancel-timeout',
              'Workflow cancellation did not return',
              'timeout',
              'unknown',
            ).error,
          );
          return;
        }
        await boundedClose(options.wait(entry), options.timeoutMs);
        const snapshot = await boundedClose(
          entry.engine.get(entry.ref, options.context),
          options.timeoutMs,
        );
        if (snapshot?.ok && isWorkflowSettled(snapshot.value)) released.push(ref);
        else unresolved.push(ref);
      } catch (error) {
        unresolved.push(ref);
        errors.push(
          fail(
            'workflow.close',
            error instanceof Error ? 'Workflow adapter cleanup threw' : 'Workflow cleanup failed',
            'internal',
            'unknown',
          ).error,
        );
      }
    }),
  );
  return { errors, released, unresolved };
}
