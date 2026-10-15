import { digest, fail, ok } from '../foundation/contracts.js';
import type { Contracts, Runtime } from '../reference/index.js';
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
