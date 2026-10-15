import { fail, ok } from '../foundation/contracts.js';
import type { Contracts, Model, Runtime } from '../reference/index.js';
export const costPolicyKey: Contracts.ServiceKey<{ currency: string }> = {
  id: 'part/estimated-cost-policy',
  contractVersion: 1,
  scope: 'run',
};
export interface CostEstimator {
  readonly id: string;
  readonly version: string;
  estimate(
    request: Model.Invocation,
    profile: Model.Profile,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<{ amount: string; currency: string }>>;
}
/** Integer millionths avoid floating point changes to decimal budget decisions. */
export function costUnits(amount: string): Contracts.Result<number> {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount))
    return fail(
      'cost.amount',
      'Cost must be a nonnegative decimal with at most six fractional digits',
    );
  const [whole, fraction = ''] = amount.split('.');
  const units = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  return units <= BigInt(Number.MAX_SAFE_INTEGER)
    ? ok(Number(units))
    : fail('cost.amount', 'Cost exceeds supported precision');
}
export function costServices(
  context: Contracts.InvocationContext,
  services: Contracts.ServiceAccess,
  limits?: Runtime.ExecutionLimits,
): Contracts.Result<Contracts.ServiceAccess> {
  const selected = limits?.estimatedCostCeiling;
  if (!selected) return ok(services);
  const units = costUnits(selected.amount);
  if (!units.ok || !/^[A-Z]{3}$/.test(selected.currency))
    return fail('cost.ceiling', 'Invalid estimated cost ceiling');
  const upstream = context.services.get(costPolicyKey);
  if (upstream.ok && upstream.value.currency !== selected.currency)
    return fail('cost.currency', 'A child cannot change the parent budget currency');
  return ok({
    get(key) {
      return key.id === costPolicyKey.id
        ? ok({ currency: selected.currency } as never)
        : services.get(key);
    },
  });
}
