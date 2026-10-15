import { fail, ok } from '../contracts/index.js';
import type { Contracts } from '../reference/contracts.js';
import type { Runtime } from '../reference/runtime.js';
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

export function reserve(
  context: Contracts.InvocationContext,
  dimension: string,
  quantity = 1,
): Contracts.Result<Runtime.BudgetReservation | undefined> {
  const budget = context.services.get(budgetKey);
  return budget.ok ? budget.value.reserve(dimension, quantity) : ok(undefined);
}
