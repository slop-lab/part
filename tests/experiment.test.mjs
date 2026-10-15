// @ts-check
import { expectProperty } from '../fixtures/assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { alternateBoundary } from '../experiments/alternate-boundary.mjs';
import { createBoundary, managedAttempt } from '@slop-lab/part/runtime/index.js';
import { localContext } from '@slop-lab/part/contracts/index.js';
test('C12/G08: independent source boundary variant preserves nominal effect count and single-use settlement', async () => {
  const counts = [];
  for (const create of [createBoundary, alternateBoundary]) {
    let count = 0;
    const boundary = create(),
      context = localContext(),
      /** @type {import('@slop-lab/part/reference/index.js').Runtime.EffectPlan} */
      plan = {
        operationId: 'o',
        attemptId: 'a',
        target: 't',
        executor: 'e',
        inputDigest: 'i',
        scopeDigest: 's',
        compositionRevision: 'r',
        classification: 'write',
      };
    const result = await managedAttempt(
      boundary,
      plan,
      async () => {
        count++;
        return { kind: 'returned', value: 42, effect: 'applied' };
      },
      context,
    );
    assert.equal(result.phase, 'completed');
    counts.push(count);
    const permit = expectProperty(
      await boundary.prepare({ ...plan, attemptId: 'b' }, context),
      'value',
    );
    assert.equal(
      (
        await boundary.settle(
          permit,
          { kind: 'returned', value: 1, effect: 'not-applied' },
          context,
        )
      ).ok,
      true,
    );
    assert.equal(
      (
        await boundary.settle(
          permit,
          { kind: 'returned', value: 1, effect: 'not-applied' },
          context,
        )
      ).ok,
      false,
    );
  }
  assert.deepEqual(counts, [1, 1]);
});
