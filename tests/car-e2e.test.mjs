// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCarDemo } from '../car/scripts/demo.mjs';

test('CAR remote development changes files, runs verification, substitutes tools, cancels and reopens history', async () => {
  const result = await runCarDemo();
  assert.deepEqual(result, {
    file: 'after',
    modelRequests: 5,
    substituteExecutions: 1,
    history: 'reopened',
    transport: 'real HTTP + SSE',
    cancellation: 'completed',
  });
});
