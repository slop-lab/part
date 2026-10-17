// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  startMockProvider,
  createMockProviderClient,
} from '@slop-lab/part-node/testing/mock-provider/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { openCar } from '../car/src/runtime.mjs';

test('CAR subagent inspects a target system model request and directly chooses its response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'car-operator-'));
  const target = await startMockProvider({
    mode: 'interactive',
    project: { id: 'target-under-test' },
  });
  const operator = createMockProviderClient(target.session);
  const incoming = fetch(`${target.session.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.session.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'target',
      messages: [{ role: 'user', content: 'Test target request' }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const pending = (await operator.pending(10_000, AbortSignal.timeout(15_000)))[0];
  assert.ok(pending);
  const model = fakeModel([
    {
      toolCalls: [
        {
          name: 'swe_subagent',
          arguments: {
            task: 'Act as target model',
            context: 'Inspect and answer the target request using operator tools.',
          },
        },
      ],
    },
    { toolCalls: [{ name: 'mock_provider_pending', arguments: { waitMs: 0 } }] },
    { toolCalls: [{ name: 'mock_provider_inspect', arguments: { requestId: pending.id } }] },
    {
      toolCalls: [
        {
          name: 'mock_provider_respond',
          arguments: {
            requestId: pending.id,
            decisionId: 'subagent/response',
            reply: { kind: 'completion', content: 'A response chosen by the operator subagent' },
          },
        },
      ],
    },
    { text: 'Target response delivered.' },
    { text: 'Subagent testing completed.' },
  ]);
  const car = await openCar({
    root: directory,
    stateDirectory: join(directory, 'state'),
    model,
    operator,
  });
  try {
    const outcome = await car.agent.generate(
      'Delegate inspection and response of the target model request.',
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.value.phase, 'completed');
    const response = await incoming;
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'A response chosen by the operator subagent');
    assert.equal((await operator.inspect(pending.id)).decisionId, 'subagent/response');
    await assert.rejects(
      operator.respond(pending.id, 'late-different-decision', {
        kind: 'completion',
        content: 'wrong',
      }),
    );
  } finally {
    await car.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
});
