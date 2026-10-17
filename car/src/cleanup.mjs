// @ts-check
import { fail } from '@slop-lab/part/contracts/index.js';

/** Run every ordered cleanup stage, even when an adapter throws.
 * @param {readonly {name: string, close(): Promise<import('@slop-lab/part/reference/index.js').Contracts.CleanupReport | void> | import('@slop-lab/part/reference/index.js').Contracts.CleanupReport | void}[]} stages */
export async function cleanupStages(stages) {
  /** @type {import('@slop-lab/part/reference/index.js').Contracts.EntityRef[]} */
  const released = [],
    unresolved = [];
  /** @type {import('@slop-lab/part/reference/index.js').Contracts.Failure[]} */
  const errors = [];
  for (const stage of stages) {
    try {
      const result = await stage.close();
      if (result) {
        released.push(...result.released);
        unresolved.push(...result.unresolved);
        errors.push(...result.errors);
      }
    } catch (error) {
      errors.push(
        fail(
          'car.cleanup',
          `Cleanup failed at ${stage.name}: ${error instanceof Error ? error.name : 'unknown error'}`,
          'internal',
          'unknown',
        ).error,
      );
      unresolved.push({ owner: 'car/runtime', kind: 'car/cleanup', id: stage.name });
    }
  }
  return { released, unresolved, errors };
}
