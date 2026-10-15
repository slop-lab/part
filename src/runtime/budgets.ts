import { fail, ok } from '../foundation/contracts.js';
import type { Contracts, Runtime } from '../reference/index.js';
import { costUnits } from './costs.js';
import { budgetKey, createBudget } from './index.js';
/** Every local reservation also reserves the upstream owner. Failed admission rolls back. */
export function createChildBudget(
  context: Contracts.InvocationContext,
  limits: Readonly<Record<string, number>>,
): Runtime.BudgetPort {
  const child = createBudget(limits),
    upstream = context.services.get(budgetKey);
  const pairs = new WeakMap<Runtime.BudgetReservation, Runtime.BudgetReservation>();
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
  limits: Runtime.ExecutionLimits = {},
): Contracts.Result<Readonly<Record<string, number>>> {
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
