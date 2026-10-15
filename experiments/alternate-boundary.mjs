// Independent experimental source implementation of the attempt boundary.
// This module is not distributed and does not establish new production guarantees.
import { ok, fail, digest } from '../dist/foundation/contracts.js';
export function alternateBoundary() {
  const issued = new Map();
  return {
    async prepare(plan, context) {
      if (context.signal.aborted) return fail('experiment.cancelled', 'Cancelled', 'cancelled');
      const permit = {
        attemptId: plan.attemptId,
        planDigest: await digest(plan),
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
