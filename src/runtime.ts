import type { Contracts as C, Runtime as R } from './reference.js';
import { ok, fail, digest } from './contracts.js';

export function createBudget(limits: Readonly<Record<string, number>> = {}): R.BudgetPort {
  const used = new Map<string, number>(), reservations = new Map<string, R.BudgetReservation>();
  return {
    reserve(dimension, quantity) {
      if (!Number.isFinite(quantity) || quantity < 0) return fail('budget.quantity', 'Invalid reservation');
      const current = used.get(dimension) ?? 0, ceiling = limits[dimension] ?? Infinity;
      if (current + quantity > ceiling) return fail('budget.exhausted', `Budget exhausted: ${dimension}`, 'conflict');
      const reservation = Object.freeze({ id: crypto.randomUUID(), dimension, quantity });
      used.set(dimension, current + quantity); reservations.set(reservation.id, reservation); return ok(reservation);
    },
    settle(reservation, actual) {
      if (reservations.get(reservation.id) !== reservation) return fail('budget.reservation', 'Unknown or settled reservation');
      if (actual !== undefined && (!Number.isFinite(actual) || actual < 0)) return fail('budget.quantity', 'Invalid actual usage');
      reservations.delete(reservation.id);
      used.set(reservation.dimension, (used.get(reservation.dimension) ?? 0) + (actual ?? reservation.quantity) - reservation.quantity);
      return ok(undefined);
    },
  };
}

/** A bounded multicast stream. Readers never own execution. */
export function createProgress(defaultCapacity = 64) {
  let index = 0, ended = false;
  type Reader = { queue: R.Update[]; wake?: () => void; capacity: number; closed: boolean };
  const readers = new Set<Reader>();
  const publish: R.ProgressSink['publish'] = (type, payload) => {
    if (ended) return ok({ accepted: false, dropped: 0 });
    const update: R.Update = { kind: 'data', index: ++index, type, payload: structuredClone(payload) };
    let dropped = 0;
    for (const reader of readers) {
      if (reader.queue.length >= reader.capacity) {
        const old = reader.queue.splice(0);
        const first = old[0]!;
        reader.queue.push({ kind: 'gap', from: first.kind === 'gap' ? first.from : first.index, to: index - 1, recovery: 'snapshot' });
        dropped += old.length;
      }
      reader.queue.push(update); reader.wake?.(); reader.wake = undefined;
    }
    return ok({ accepted: true, dropped });
  };
  return { publish, end() { ended = true; for (const reader of readers) reader.wake?.(); },
    observe(options: { signal?: AbortSignal; bufferSize?: number } = {}): AsyncIterable<R.Update> {
      return { [Symbol.asyncIterator]() {
        const reader: Reader = { queue: [], capacity: Math.max(2, Math.floor(options.bufferSize ?? defaultCapacity)), closed: false };
        readers.add(reader);
        const close = () => { reader.closed = true; reader.queue.length = 0; readers.delete(reader); reader.wake?.(); options.signal?.removeEventListener('abort', close); };
        options.signal?.addEventListener('abort', close, { once: true }); if (options.signal?.aborted) close();
        return { async next() {
          while (!reader.closed && !reader.queue.length && !ended) await new Promise<void>(resolve => { reader.wake = resolve; });
          const value = reader.queue.shift();
          if (value) return { done: false as const, value: structuredClone(value) };
          close(); return { done: true as const, value: undefined };
        }, async return() { close(); return { done: true as const, value: undefined }; } };
      } };
    },
  };
}
export type OperationContext = C.InvocationContext & { readonly progress: R.ProgressSink };
export interface Operations extends R.OperationService {
  begin<T>(spec: R.OperationSpec, body: (context: OperationContext) => Promise<R.ManagedOutcome<T>>, context: C.InvocationContext): Promise<C.Result<R.ExecutionHandle<T>>>;
  get(ref: C.EntityRef): C.Result<R.ExecutionSnapshot>;
}
export function createOperations(options: { cancellationGraceMs?: number; maxRetained?: number } = {}): Operations {
  const records = new Map<string, { handle: R.ExecutionHandle<unknown>; children: Set<string>; controller: AbortController }>();
  const grace = options.cancellationGraceMs ?? 100;
  return {
    get(ref) { const record = records.get(ref.id); return record && record.handle.ref.owner === ref.owner ? ok(record.handle.snapshot()) : fail('operation.missing', ref.id); },
    async begin<T>(spec: R.OperationSpec, body: (context: OperationContext) => Promise<R.ManagedOutcome<T>>, parentContext: C.InvocationContext) {
      if (spec.childPolicy !== 'attached') return fail('operation.transfer', 'Ownership transfer requires an external host', 'unsupported');
      if (parentContext.signal.aborted) return fail('operation.cancelled', 'Parent is cancelled', 'cancelled');
      if (parentContext.deadline && (!Number.isFinite(Date.parse(parentContext.deadline)) || Date.parse(parentContext.deadline) <= Date.now())) return fail('operation.deadline', 'Deadline exceeded or invalid', 'timeout');
      const parent = spec.parent ? records.get(spec.parent.id) : undefined;
      if (spec.parent && (!parent || parent.handle.ref.owner !== spec.parent.owner || !['pending', 'running', 'waiting'].includes(parent.handle.snapshot().phase))) return fail('operation.parent', 'Parent is absent or terminal', 'conflict');
      const ref: C.EntityRef = { owner: 'part/operations', kind: spec.kind, id: crypto.randomUUID() };
      const controller = new AbortController(), progress = createProgress();
      let snapshot: R.ExecutionSnapshot = { ref, revision: '0', phase: 'pending', cancel: { state: 'not-requested', unresolvedTargets: [] }, effect: 'not-attempted', ...(spec.parent ? { parent: spec.parent } : {}) };
      let revision = 0, finished = false, cancelTimer: ReturnType<typeof setTimeout> | undefined, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveDone!: (value: R.ManagedOutcome<T>) => void;
      const done = new Promise<R.ManagedOutcome<T>>(resolve => { resolveDone = resolve; });
      const children = new Set<string>();
      const update = (change: Partial<R.ExecutionSnapshot>) => { snapshot = { ...snapshot, ...change, revision: String(++revision) }; progress.publish('part.operation/state', snapshot as unknown as C.Json); };
      const finish = (outcome: R.ManagedOutcome<T>) => {
        if (finished) return;
        finished = true; clearTimeout(cancelTimer); clearTimeout(deadlineTimer);
        parentContext.signal.removeEventListener('abort', abort); parent?.controller.signal.removeEventListener('abort', abort);
        const cancel: R.Cancellation = controller.signal.aborted ? { state: outcome.phase === 'abandoned' ? 'partial' : 'confirmed', unresolvedTargets: outcome.phase === 'abandoned' ? [ref, ...outcome.unsettledChildren] : outcome.unsettledChildren } : snapshot.cancel;
        update({ phase: outcome.phase, effect: outcome.effect, cancel, ...('error' in outcome && outcome.error ? { error: outcome.error } : {}) });
        progress.end(); if (outcome.phase !== 'abandoned') parent?.children.delete(ref.id); resolveDone(outcome);
        const max = options.maxRetained ?? 1000;
        if (records.size > max) for (const [id, record] of records) {
          if (records.size <= max) break;
          if (!['pending', 'running', 'waiting'].includes(record.handle.snapshot().phase)) records.delete(id);
        }
      };
      const requestCancel = async (_reason: string): Promise<C.Result<R.Cancellation>> => {
        if (finished || controller.signal.aborted) return ok(snapshot.cancel);
        controller.abort(); update({ cancel: { state: 'requested', unresolvedTargets: [ref] } });
        for (const id of children) void records.get(id)?.handle.requestCancel('parent-cancelled');
        cancelTimer = setTimeout(() => finish({ phase: 'abandoned', error: { code: 'part.cancellation.unconfirmed', category: 'cancelled', message: 'Execution did not acknowledge cancellation', retry: 'after-reconciliation' }, effect: 'unknown', unsettledChildren: [...children].flatMap(id => records.get(id)?.handle.ref ?? []), commit: [] }), grace);
        return ok(snapshot.cancel);
      };
      const abort = () => { void requestCancel('parent-cancelled'); };
      const handle: R.ExecutionHandle<T> = { ref, done, snapshot: () => structuredClone(snapshot), observe: progress.observe, requestCancel };
      records.set(ref.id, { handle, children, controller }); parent?.children.add(ref.id);
      parentContext.signal.addEventListener('abort', abort, { once: true }); parent?.controller.signal.addEventListener('abort', abort, { once: true });
      if (parentContext.signal.aborted || parent?.controller.signal.aborted) abort();
      if (parentContext.deadline) deadlineTimer = setTimeout(() => { void requestCancel('deadline'); }, Math.max(0, Date.parse(parentContext.deadline) - Date.now()));
      queueMicrotask(async () => {
        if (finished) return;
        if (controller.signal.aborted) { finish({ phase: 'cancelled', effect: 'not-attempted', unsettledChildren: [], commit: [] }); return; }
        update({ phase: 'running' });
        const context: OperationContext = { ...parentContext, scope: { kind: 'operation', id: ref.id }, signal: controller.signal, progress };
        let outcome: R.ManagedOutcome<T>;
        try { outcome = await body(context); }
        catch { outcome = { phase: 'failed', error: { code: 'part.operation.exception', category: 'internal', message: 'Operation failed', retry: 'after-reconciliation' }, effect: 'unknown', unsettledChildren: [], commit: [] }; }
        if (finished) return;
        const childHandles = [...children].flatMap(id => records.get(id)?.handle ?? []);
        for (const child of childHandles) await child.requestCancel('parent-finished');
        const childOutcomes = await Promise.all(childHandles.map(child => child.done));
        const unresolved = childHandles.filter((_, i) => childOutcomes[i]!.phase === 'abandoned').map(child => child.ref);
        if (unresolved.length) outcome = { phase: 'abandoned', error: { code: 'part.children.unresolved', category: 'internal', message: 'Attached children remain unresolved', retry: 'after-reconciliation' }, effect: 'unknown', unsettledChildren: unresolved, commit: outcome.commit };
        else if (controller.signal.aborted) outcome = { phase: 'cancelled', effect: outcome.effect, unsettledChildren: [], commit: outcome.commit };
        finish(outcome);
      });
      return ok(handle);
    },
  };
}

export function createBoundary(hooks: { prepare?: (plan: R.EffectPlan, context: C.InvocationContext) => Promise<C.Result<void>>; settle?: (plan: R.EffectPlan, outcome: R.AttemptOutcome<unknown>, context: C.InvocationContext) => Promise<C.Result<readonly C.CommitEvidence[]>> } = {}): R.InvocationBoundary {
  const permits = new WeakMap<R.AttemptPermit, R.EffectPlan>();
  return {
    async prepare(plan, context) {
      if (context.signal.aborted) return fail('boundary.cancelled', 'Cancelled before prepare', 'cancelled');
      const fixed = Object.freeze({ ...plan });
      const checked = await hooks.prepare?.(fixed, context); if (checked && !checked.ok) return checked;
      if (context.signal.aborted) return fail('boundary.cancelled', 'Cancelled during prepare', 'cancelled');
      const permit = Object.freeze({ attemptId: fixed.attemptId, planDigest: await digest(fixed as unknown as C.Json), boundary: 'part/boundary' });
      permits.set(permit, fixed); return ok(permit);
    },
    async settle(permit, outcome, context) {
      const plan = permits.get(permit); if (!plan) return fail('boundary.permit', 'Unknown or consumed permit', 'permission');
      permits.delete(permit);
      return hooks.settle ? hooks.settle(plan, outcome, context) : ok([]);
    },
  };
}
const consumed = new WeakSet<R.AttemptPermit>();
export async function managedAttempt<T>(boundary: R.InvocationBoundary, plan: R.EffectPlan, execute: (permit: R.AttemptPermit) => Promise<R.AttemptOutcome<T>>, context: C.InvocationContext): Promise<R.ManagedOutcome<T>> {
  const evidence = { effect: 'not-attempted' as C.EffectState, unsettledChildren: [] as C.EntityRef[], commit: [] as readonly C.CommitEvidence[] };
  let permit: C.Result<R.AttemptPermit>;
  try { permit = await boundary.prepare(plan, context); } catch { permit = fail('boundary.prepare', 'Prepare failed', 'internal'); }
  if (!permit.ok) return { ...evidence, phase: 'failed', error: permit.error };
  if (consumed.has(permit.value) || permit.value.attemptId !== plan.attemptId || permit.value.planDigest !== await digest(plan as unknown as C.Json)) return { ...evidence, phase: 'failed', error: { code: 'part.boundary.permit', category: 'permission', message: 'Invalid attempt permit', retry: 'never' } };
  consumed.add(permit.value);
  let attempt: R.AttemptOutcome<T>;
  if (context.signal.aborted || (context.deadline && Date.parse(context.deadline) <= Date.now())) attempt = { kind: 'cancelled', effect: 'not-attempted' };
  else try { attempt = await execute(permit.value); } catch { attempt = { kind: 'failed', effect: 'unknown', error: { code: 'part.executor.exception', category: 'internal', message: 'Executor failed', retry: 'after-reconciliation' } }; }
  let settled: C.Result<readonly C.CommitEvidence[]>;
  try { settled = await boundary.settle(permit.value, attempt, context); } catch { settled = fail('boundary.settle', 'Settlement failed', 'internal'); }
  if (!settled.ok) return { ...evidence, phase: 'failed', effect: attempt.effect, error: { ...settled.error, effect: attempt.effect, retry: 'after-reconciliation' } };
  const committed = { ...evidence, effect: attempt.effect, commit: settled.value };
  if (context.signal.aborted || attempt.kind === 'cancelled') return { ...committed, phase: 'cancelled' };
  return attempt.kind === 'returned' ? { ...committed, phase: 'completed', result: attempt.value } : { ...committed, phase: 'failed', error: attempt.error };
}
