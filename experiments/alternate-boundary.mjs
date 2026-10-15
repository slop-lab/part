// @ts-check
// Independent experimental source implementation of the attempt boundary.
// This module is not distributed and does not establish new production guarantees.
import { digest, fail, ok } from '@slop-lab/part/contracts/index.js';
/** @returns {import("@slop-lab/part/reference/index.js").Runtime.InvocationBoundary} */
export function alternateBoundary() {
  /** @type {Map<import("@slop-lab/part/reference/index.js").Runtime.AttemptPermit, import("@slop-lab/part/reference/index.js").Runtime.EffectPlan>} */
  const issued = new Map();
  return {
    async prepare(plan, context) {
      if (context.signal.aborted) return fail('experiment.cancelled', 'Cancelled', 'cancelled');
      const permit = {
        attemptId: plan.attemptId,
        planDigest: await digest({ ...plan }),
        boundary: 'experiment/map-boundary',
      };
      issued.set(permit, structuredClone(plan));
      return ok(permit);
    },
    async settle(permit, _outcome) {
      if (!issued.delete(permit)) return fail('experiment.permit', 'Unknown permit', 'permission');
      return ok([]);
    },
  };
}
