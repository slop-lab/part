import type { Contracts as C, Runtime as R } from './reference.js';
import { createBudget, budgetKey } from './runtime.js';
import { costUnits } from './costs.js';
import { ok, fail } from './contracts.js';
/** Every local reservation also reserves the upstream owner. Failed admission rolls back. */
export function createChildBudget(
  context: C.InvocationContext,
  limits: Readonly<Record<string, number>>,
): R.BudgetPort {
  const child = createBudget(limits),
    upstream = context.services.get(budgetKey);
  const pairs = new WeakMap<R.BudgetReservation, R.BudgetReservation>();
  return {
    reserve(dimension, quantity) {
      const reserved = child.reserve(dimension, quantity);
      if (!reserved.ok || !upstream.ok) return reserved;
      const parent = upstream.value.reserve(dimension, quantity);
      if (!parent.ok) {
        child.settle(reserved.value, 0);
        return parent;
      }
      pairs.set(reserved.value, parent.value);
      return reserved;
    },
    settle(reservation, actual) {
      const settled = child.settle(reservation, actual);
      if (!settled.ok) return settled;
      const parent = pairs.get(reservation);
      pairs.delete(reservation);
      return upstream.ok && parent ? upstream.value.settle(parent, actual) : settled;
    },
  };
}
export function numericLimits(
  limits: R.ExecutionLimits = {},
): C.Result<Readonly<Record<string, number>>> {
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (key === 'deadline') continue;
    if (key === 'estimatedCostCeiling') {
      const cost = limits.estimatedCostCeiling!;
      const units = costUnits(cost.amount);
      if (!units.ok || !/^[A-Z]{3}$/.test(cost.currency))
        return fail('budget.cost', 'Invalid estimated cost ceiling');
      numeric['estimatedCost/' + cost.currency] = units.value;
      continue;
    }
    if (
      ![
        'maxModelInvocations',
        'maxToolDispatches',
        'maxExecutorAttempts',
        'maxChildRuns',
        'maxConcurrentOperations',
        'maxKnownTokens',
      ].includes(key) ||
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    )
      return fail('budget.limit', 'Invalid or uninstalled budget dimension');
    numeric[key] = value;
  }
  return ok(numeric);
}
