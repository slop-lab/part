import { scheduleDeadline } from './deadline.js';
import type { Contracts, Runtime } from './reference.js';
import { ok, fail, digest, isJson } from './contracts.js';

export const budgetKey: Contracts.ServiceKey<Runtime.BudgetPort> = {
  id: 'part/budget',
  contractVersion: 1,
  scope: 'run',
};
export function createBudget(limits: Readonly<Record<string, number>> = {}): Runtime.BudgetPort {
  const used = new Map<string, number>(),
    reservations = new Map<string, Runtime.BudgetReservation>();
  return {
    reserve(dimension, quantity) {
      if (!Number.isFinite(quantity) || quantity < 0)
        return fail('budget.quantity', 'Invalid reservation');
      const current = used.get(dimension) ?? 0,
        ceiling = limits[dimension] ?? Infinity;
      if (current + quantity > ceiling)
        return fail('budget.exhausted', `Budget exhausted: ${dimension}`, 'conflict');
      const reservation = Object.freeze({ id: crypto.randomUUID(), dimension, quantity });
      used.set(dimension, current + quantity);
      reservations.set(reservation.id, reservation);
      return ok(reservation);
    },
    settle(reservation, actual) {
      if (reservations.get(reservation.id) !== reservation)
        return fail('budget.reservation', 'Unknown or settled reservation');
      if (actual !== undefined && (!Number.isFinite(actual) || actual < 0))
        return fail('budget.quantity', 'Invalid actual usage');
      reservations.delete(reservation.id);
      used.set(
        reservation.dimension,
        (used.get(reservation.dimension) ?? 0) +
          (actual ?? reservation.quantity) -
          reservation.quantity,
      );
      return ok(undefined);
    },
  };
}

/** A bounded multicast stream. Readers never own execution. */
export function createProgress(defaultCapacity = 64) {
  let index = 0,
    ended = false;
  type Reader = { queue: Runtime.Update[]; wake?: () => void; capacity: number; closed: boolean };
  const readers = new Set<Reader>();
  const publish: Runtime.ProgressSink['publish'] = (type, payload) => {
    if (ended) return ok({ accepted: false, dropped: 0 });
    if (!isJson(payload)) return fail('progress.payload', 'Progress payload must be lossless JSON');
    const update: Runtime.Update = {
      kind: 'data',
      index: ++index,
      type,
      payload: structuredClone(payload),
    };
    let dropped = 0;
    for (const reader of readers) {
      if (reader.queue.length >= reader.capacity) {
        const old = reader.queue.splice(0);
        const first = old[0]!;
        reader.queue.push({
          kind: 'gap',
          from: first.kind === 'gap' ? first.from : first.index,
          to: index - 1,
          recovery: 'snapshot',
        });
        dropped += old.length;
      }
      reader.queue.push(update);
      reader.wake?.();
      reader.wake = undefined;
    }
    return ok({ accepted: true, dropped });
  };
  return {
    publish,
    end() {
      ended = true;
      for (const reader of readers) reader.wake?.();
    },
    observe(
      options: { signal?: AbortSignal; bufferSize?: number } = {},
    ): AsyncIterable<Runtime.Update> {
      return {
        [Symbol.asyncIterator]() {
          const reader: Reader = {
            queue: [],
            capacity: Math.min(
              4096,
              Math.max(
                2,
                Math.floor(
                  Number.isFinite(options.bufferSize ?? defaultCapacity)
                    ? (options.bufferSize ?? defaultCapacity)
                    : 64,
                ),
              ),
            ),
            closed: false,
          };
          readers.add(reader);
          const close = () => {
            reader.closed = true;
            reader.queue.length = 0;
            readers.delete(reader);
            reader.wake?.();
            options.signal?.removeEventListener('abort', close);
          };
          options.signal?.addEventListener('abort', close, { once: true });
          if (options.signal?.aborted) close();
          return {
            async next() {
              while (!reader.closed && !reader.queue.length && !ended)
                await new Promise<void>((resolve) => {
                  reader.wake = resolve;
                });
              const value = reader.queue.shift();
              if (value) return { done: false as const, value: structuredClone(value) };
              close();
              return { done: true as const, value: undefined };
            },
            async return() {
              close();
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },
  };
}
export type OperationContext = Contracts.InvocationContext & {
  readonly progress: Runtime.ProgressSink;
  wait<T>(pending: Promise<T>): Promise<T>;
};
export interface Operations extends Runtime.OperationService {
  begin<T>(
    spec: Runtime.OperationSpec,
    body: (context: OperationContext) => Promise<Runtime.ManagedOutcome<T>>,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Runtime.ExecutionHandle<T>>>;
  get(ref: Contracts.EntityRef): Contracts.Result<Runtime.ExecutionSnapshot>;
}
export const operationOwnerKey: Contracts.ServiceKey<Operations> = {
  id: 'part/operation-owner',
  contractVersion: 1,
  scope: 'operation',
};
export function createOperations(
  options: { cancellationGraceMs?: number; maxRetained?: number } = {},
): Operations {
  const records = new Map<
    string,
    {
      handle: Runtime.ExecutionHandle<unknown>;
      children: Set<string>;
      controller: AbortController;
      deadline?: string;
      services: Contracts.ServiceAccess;
    }
  >();
  const grace = options.cancellationGraceMs ?? 100;
  const supervisor: Operations = {
    get(ref) {
      const record = records.get(ref.id);
      return record && record.handle.ref.owner === ref.owner && record.handle.ref.kind === ref.kind
        ? ok(record.handle.snapshot())
        : fail('operation.missing', ref.id);
    },
    async begin<T>(
      spec: Runtime.OperationSpec,
      body: (context: OperationContext) => Promise<Runtime.ManagedOutcome<T>>,
      parentContext: Contracts.InvocationContext,
    ) {
      const owner =
        parentContext.scope.kind === 'operation'
          ? parentContext.services.get(operationOwnerKey)
          : undefined;
      if (owner?.ok && owner.value !== supervisor)
        return owner.value.begin(spec, body, parentContext);
      if (spec.childPolicy !== 'attached')
        return fail(
          'operation.transfer',
          'Ownership transfer requires an external host',
          'unsupported',
        );
      if (parentContext.signal.aborted)
        return fail('operation.cancelled', 'Parent is cancelled', 'cancelled');
      if (
        parentContext.deadline &&
        (!Number.isFinite(Date.parse(parentContext.deadline)) ||
          Date.parse(parentContext.deadline) <= Date.now())
      )
        return fail('operation.deadline', 'Deadline exceeded or invalid', 'timeout');
      const parentRef =
        spec.parent ??
        (parentContext.scope.kind === 'operation'
          ? records.get(parentContext.scope.id)?.handle.ref
          : undefined);
      const parent = parentRef ? records.get(parentRef.id) : undefined;
      if (
        parentRef &&
        (!parent ||
          parent.handle.ref.owner !== parentRef.owner ||
          parent.handle.ref.kind !== parentRef.kind ||
          !['pending', 'running', 'waiting'].includes(parent.handle.snapshot().phase))
      )
        return fail('operation.parent', 'Parent is absent or terminal', 'conflict');
      const deadlines = [parentContext.deadline, parent?.deadline]
        .filter((v): v is string => !!v)
        .map(Date.parse);
      const effectiveDeadline = deadlines.length
        ? new Date(Math.min(...deadlines)).toISOString()
        : undefined;
      const budget = parentContext.services.get(budgetKey);
      const concurrency =
        spec.kind !== 'part/run' && spec.kind !== 'part/workflow' && budget.ok
          ? budget.value.reserve('maxConcurrentOperations', 1)
          : ok(undefined);
      if (!concurrency.ok) return concurrency;
      const ref: Contracts.EntityRef = Object.freeze({
        owner: 'part/operations',
        kind: spec.kind,
        id: crypto.randomUUID(),
      });
      const controller = new AbortController(),
        progress = createProgress();
      let snapshot: Runtime.ExecutionSnapshot = {
        ref,
        revision: '0',
        phase: 'pending',
        cancel: { state: 'not-requested', unresolvedTargets: [] },
        effect: 'not-attempted',
        ...(parentRef ? { parent: parentRef } : {}),
      };
      let revision = 0,
        finished = false,
        cancelTimer: ReturnType<typeof setTimeout> | undefined,
        cancelDeadline: (() => void) | undefined;
      let resolveDone!: (value: Runtime.ManagedOutcome<T>) => void;
      const done = new Promise<Runtime.ManagedOutcome<T>>((resolve) => {
        resolveDone = resolve;
      });
      const children = new Set<string>();
      const update = (change: Partial<Runtime.ExecutionSnapshot>) => {
        snapshot = { ...snapshot, ...change, revision: String(++revision) };
        progress.publish('part.operation/state', snapshot as unknown as Contracts.Json);
      };
      const finish = (outcome: Runtime.ManagedOutcome<T>) => {
        if (finished) return;
        finished = true;
        if (budget.ok && concurrency.value && outcome.phase !== 'abandoned')
          budget.value.settle(concurrency.value, 0);
        clearTimeout(cancelTimer);
        cancelDeadline?.();
        parentContext.signal.removeEventListener('abort', abort);
        parent?.controller.signal.removeEventListener('abort', abort);
        const cancel: Runtime.Cancellation = controller.signal.aborted
          ? {
              state:
                outcome.phase === 'abandoned' || outcome.unsettledChildren.length
                  ? 'partial'
                  : 'confirmed',
              unresolvedTargets:
                outcome.phase === 'abandoned'
                  ? [ref, ...outcome.unsettledChildren]
                  : outcome.unsettledChildren,
            }
          : snapshot.cancel;
        update({
          phase: outcome.phase,
          effect: outcome.effect,
          cancel,
          ...('error' in outcome && outcome.error ? { error: outcome.error } : {}),
        });
        progress.end();
        controller.abort();
        if (outcome.phase !== 'abandoned') parent?.children.delete(ref.id);
        resolveDone(outcome);
        const max = options.maxRetained ?? 1000;
        if (records.size > max)
          for (const [id, record] of records) {
            if (records.size <= max) break;
            if (
              !['pending', 'running', 'waiting'].includes(record.handle.snapshot().phase) &&
              !record.children.size &&
              ![...records.values()].some((owner) => owner.children.has(id))
            )
              records.delete(id);
          }
      };
      const requestCancel = async (
        _reason: string,
      ): Promise<Contracts.Result<Runtime.Cancellation>> => {
        if (finished || controller.signal.aborted) return ok(snapshot.cancel);
        controller.abort();
        update({ cancel: { state: 'requested', unresolvedTargets: [ref] } });
        for (const id of children) void records.get(id)?.handle.requestCancel('parent-cancelled');
        cancelTimer = setTimeout(
          () =>
            finish({
              phase: 'abandoned',
              error: {
                code: 'part.cancellation.unconfirmed',
                category: 'cancelled',
                message: 'Execution did not acknowledge cancellation',
                retry: 'after-reconciliation',
              },
              effect: 'unknown',
              unsettledChildren: [...children].flatMap((id) => records.get(id)?.handle.ref ?? []),
              commit: [],
            }),
          grace,
        );
        return ok(snapshot.cancel);
      };
      const abort = () => {
        void requestCancel('parent-cancelled');
      };
      const handle: Runtime.ExecutionHandle<T> = {
        ref,
        done,
        snapshot: () => structuredClone(snapshot),
        observe: progress.observe,
        requestCancel,
      };
      records.set(ref.id, {
        handle,
        children,
        controller,
        deadline: effectiveDeadline,
        services: parentContext.services,
      });
      parent?.children.add(ref.id);
      parentContext.signal.addEventListener('abort', abort, { once: true });
      parent?.controller.signal.addEventListener('abort', abort, { once: true });
      if (parentContext.signal.aborted || parent?.controller.signal.aborted) abort();
      if (effectiveDeadline)
        cancelDeadline = scheduleDeadline(Date.parse(effectiveDeadline), () => {
          void requestCancel('deadline');
        });
      queueMicrotask(async () => {
        if (finished) return;
        if (controller.signal.aborted) {
          finish({
            phase: 'cancelled',
            effect: 'not-attempted',
            unsettledChildren: [],
            commit: [],
          });
          return;
        }
        update({ phase: 'running', effect: 'unknown' });
        const context: OperationContext = {
          ...parentContext,
          services: {
            get(key) {
              return key.id === operationOwnerKey.id
                ? ok(supervisor as never)
                : parentContext.services.get(key);
            },
          },
          scope: { kind: 'operation', id: ref.id },
          signal: controller.signal,
          ...(effectiveDeadline ? { deadline: effectiveDeadline } : {}),
          progress,
          async wait(pending) {
            update({ phase: 'waiting' });
            try {
              return await pending;
            } finally {
              if (!finished) update({ phase: 'running' });
            }
          },
        };
        let outcome: Runtime.ManagedOutcome<T>;
        try {
          outcome = await body(context);
        } catch {
          outcome = {
            phase: 'failed',
            error: {
              code: 'part.operation.exception',
              category: 'internal',
              message: 'Operation failed',
              retry: 'after-reconciliation',
            },
            effect: 'unknown',
            unsettledChildren: [],
            commit: [],
          };
        }
        if (finished) return;
        const childHandles = [...children].flatMap((id) => records.get(id)?.handle ?? []);
        for (const child of childHandles) await child.requestCancel('parent-finished');
        const childOutcomes = await Promise.all(childHandles.map((child) => child.done));
        const unresolved = childHandles
          .filter((_, i) => childOutcomes[i]!.phase === 'abandoned')
          .map((child) => child.ref);
        if (unresolved.length)
          outcome = {
            phase: 'abandoned',
            error: {
              code: 'part.children.unresolved',
              category: 'internal',
              message: 'Attached children remain unresolved',
              retry: 'after-reconciliation',
            },
            effect: 'unknown',
            unsettledChildren: unresolved,
            commit: outcome.commit,
          };
        else if (
          controller.signal.aborted &&
          outcome.phase !== 'abandoned' &&
          !outcome.unsettledChildren.length
        )
          outcome = {
            phase: 'cancelled',
            effect: outcome.effect,
            unsettledChildren: [],
            commit: outcome.commit,
          };
        finish(outcome);
      });
      return ok(handle);
    },
  };
  return supervisor;
}

export function createBoundary(
  hooks: {
    prepare?: (
      plan: Runtime.EffectPlan,
      context: Contracts.InvocationContext,
    ) => Promise<Contracts.Result<void>>;
    settle?: (
      plan: Runtime.EffectPlan,
      outcome: Runtime.AttemptOutcome<unknown>,
      context: Contracts.InvocationContext,
    ) => Promise<Contracts.Result<readonly Contracts.CommitEvidence[]>>;
  } = {},
): Runtime.InvocationBoundary {
  const permits = new WeakMap<Runtime.AttemptPermit, Runtime.EffectPlan>();
  return {
    async prepare(plan, context) {
      if (context.signal.aborted)
        return fail('boundary.cancelled', 'Cancelled before prepare', 'cancelled');
      const fixed = Object.freeze({ ...plan });
      const checked = await hooks.prepare?.(fixed, context);
      if (checked && !checked.ok) return checked;
      if (context.signal.aborted)
        return fail('boundary.cancelled', 'Cancelled during prepare', 'cancelled');
      const permit = Object.freeze({
        attemptId: fixed.attemptId,
        planDigest: await digest(fixed as unknown as Contracts.Json),
        boundary: 'part/boundary',
      });
      permits.set(permit, fixed);
      return ok(permit);
    },
    async settle(permit, outcome, context) {
      const plan = permits.get(permit);
      if (!plan) return fail('boundary.permit', 'Unknown or consumed permit', 'permission');
      permits.delete(permit);
      return hooks.settle ? hooks.settle(plan, outcome, context) : ok([]);
    },
  };
}
const consumed = new WeakSet<Runtime.AttemptPermit>();
export async function managedAttempt<T>(
  boundary: Runtime.InvocationBoundary,
  plan: Runtime.EffectPlan,
  execute: (permit: Runtime.AttemptPermit) => Promise<Runtime.AttemptOutcome<T>>,
  context: Contracts.InvocationContext,
): Promise<Runtime.ManagedOutcome<T>> {
  const evidence = {
    effect: 'not-attempted' as Contracts.EffectState,
    unsettledChildren: [] as Contracts.EntityRef[],
    commit: [] as readonly Contracts.CommitEvidence[],
  };
  let permit: Contracts.Result<Runtime.AttemptPermit>;
  try {
    permit = await boundary.prepare(plan, context);
  } catch {
    permit = fail('boundary.prepare', 'Prepare failed', 'internal');
  }
  if (!permit.ok) return { ...evidence, phase: 'failed', error: permit.error };
  if (
    consumed.has(permit.value) ||
    permit.value.attemptId !== plan.attemptId ||
    permit.value.planDigest !== (await digest(plan as unknown as Contracts.Json))
  )
    return {
      ...evidence,
      phase: 'failed',
      error: {
        code: 'part.boundary.permit',
        category: 'permission',
        message: 'Invalid attempt permit',
        retry: 'never',
      },
    };
  consumed.add(permit.value);
  let attempt: Runtime.AttemptOutcome<T>;
  if (context.signal.aborted || (context.deadline && Date.parse(context.deadline) <= Date.now()))
    attempt = { kind: 'cancelled', effect: 'not-attempted' };
  else
    try {
      attempt = await execute(permit.value);
    } catch {
      attempt = {
        kind: 'failed',
        effect: 'unknown',
        error: {
          code: 'part.executor.exception',
          category: 'internal',
          message: 'Executor failed',
          retry: 'after-reconciliation',
        },
      };
    }
  let settled: Contracts.Result<readonly Contracts.CommitEvidence[]>;
  try {
    settled = await boundary.settle(permit.value, attempt, context);
  } catch {
    settled = fail('boundary.settle', 'Settlement failed', 'internal');
  }
  if (!settled.ok)
    return {
      ...evidence,
      phase: 'failed',
      effect: attempt.effect,
      error: { ...settled.error, effect: attempt.effect, retry: 'after-reconciliation' },
    };
  const committed = { ...evidence, effect: attempt.effect, commit: settled.value };
  if (context.signal.aborted || attempt.kind === 'cancelled')
    return { ...committed, phase: 'cancelled' };
  return attempt.kind === 'returned'
    ? { ...committed, phase: 'completed', result: attempt.value }
    : { ...committed, phase: 'failed', error: attempt.error };
}
