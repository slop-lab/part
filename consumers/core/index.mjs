import assert from 'node:assert/strict';
import { createOperations, localContext, ok } from '@part/core';
const operations = createOperations();
const started = await operations.begin(
  { kind: 'consumer', childPolicy: 'attached', retryOwner: 'consumer' },
  async () => ({
    phase: 'completed',
    result: 42,
    effect: 'not-applied',
    commit: [],
    unsettledChildren: [],
  }),
  localContext(),
);
assert.equal(started.ok, true);
assert.equal((await started.value.done).result, 42);
assert.equal(ok(42).value, 42);
console.log('core-only consumer passed');
