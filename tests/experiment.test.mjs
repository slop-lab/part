import test from 'node:test';
import assert from 'node:assert/strict';
import { alternateBoundary } from '../experiments/alternate-boundary.mjs';
import { createBoundary, managedAttempt } from 'part/runtime';
import { localContext } from 'part/contracts';
test('C12/G08: independent source boundary variant preserves nominal effect count and single-use settlement', async () => {
  const counts = [];
  for (const create of [createBoundary, alternateBoundary]) {
    let count = 0;
    const boundary = create(),
      context = localContext(),
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
    const permit = (await boundary.prepare({ ...plan, attemptId: 'b' }, context)).value;
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
