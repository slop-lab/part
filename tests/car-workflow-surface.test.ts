import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest, isJsonObject, jsonSchema, localContext } from '@slop-lab/part/contracts/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { openCar } from '../car/src/runtime.mjs';
import type { Contracts } from '@slop-lab/part/reference/index.js';

test('CAR pipeline script and managed coding run wait for approval before workflow success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'car-workflow-surface-'));
  const directory = join(root, '.agents', 'workflows');
  await mkdir(directory, { recursive: true });
  const script = new TextEncoder().encode('console.log(JSON.stringify({collected:true}))');
  await writeFile(join(root, 'collect.cjs'), script);
  await writeFile(
    join(directory, 'verify.pipeline.json'),
    JSON.stringify({
      format: 'part.pipeline',
      version: 1,
      id: 'verify',
      input: jsonSchema.ref,
      output: jsonSchema.ref,
      steps: [
        {
          id: 'collect',
          after: [],
          kind: 'script',
          stdin: { input: '' },
          request: {
            requestId: 'collect',
            executorId: 'part/node-process',
            source: { relativePath: 'collect.cjs', digest: await digest(script) },
            interpreter: 'node',
            args: [],
            capture: { kind: 'stdout-json', maxBytes: 1024 },
            effects: 'read',
            retry: 'never',
          },
        },
        {
          id: 'agent',
          after: ['collect'],
          kind: 'agent',
          profile: 'coding',
          input: { literal: 'Verify the collected data' },
        },
        {
          id: 'review',
          after: ['agent'],
          kind: 'wait',
          response: jsonSchema.ref,
          binding: { step: 'agent', pointer: '' },
          prompt: 'Approve?',
        },
        {
          id: 'approved',
          after: ['review'],
          kind: 'assert',
          value: { step: 'review', pointer: '/approved' },
          equals: true,
        },
      ],
      result: { step: 'collect', pointer: '' },
    }),
  );
  const context = localContext();
  const car = await openCar({
    root,
    stateDirectory: join(root, 'state'),
    context,
    model: fakeModel([{ text: 'Agent stage done, workflow is not done yet' }]),
    workflows: true,
  });
  try {
    const definitions = await car.endpoint.query(
      { queryId: 'part.workflow/definitions', version: 1, input: null },
      context,
    );
    assert.ok(definitions.ok && Array.isArray(definitions.value));
    const definition = definitions.value[0];
    assert.ok(isJsonObject(definition));
    const waiting = waitForPhase(car, 'waiting', context);
    const started = await car.endpoint.command(
      {
        protocolVersion: 1,
        commandId: 'workflow-start',
        idempotencyKey: 'workflow-start',
        actionId: 'part.workflow/start',
        actionVersion: 1,
        input: {
          engineId: definition.engineId ?? null,
          definition: definition.definition ?? null,
          composition: definition.composition ?? null,
          profileId: 'default',
          input: {},
          requiredControl: 'runner-enforced',
          requiredCapabilities: [],
        },
      },
      context,
    );
    if (started.kind === 'rejected') {
      assert.fail(started.error.message);
    }
    assert.equal(started.kind, 'accepted');
    const item = await waiting;
    assert.ok(isJsonObject(item.payload) && Array.isArray(item.payload.waits));
    assert.ok(item.actions.some((action) => action.id === 'part.workflow/cancel'));
    const actions = await car.endpoint.query(
      { queryId: 'part/actions', version: 1, target: item.source, input: null },
      context,
    );
    assert.ok(
      actions.ok &&
        Array.isArray(actions.value) &&
        actions.value.some(
          (action) => isJsonObject(action) && action.id === 'part.workflow/cancel',
        ),
    );
    const wait = item.payload.waits[0];
    assert.ok(isJsonObject(wait) && isJsonObject(wait.ticket));
    const ticket = wait.ticket;
    assert.equal(typeof ticket.id, 'string');
    const completed = waitForPhase(car, 'succeeded', context);
    const responded = await car.endpoint.command(
      {
        protocolVersion: 1,
        commandId: 'approve',
        actionId: 'part.workflow/respond',
        actionVersion: 1,
        target: item.source,
        input: {
          ticketId: ticket.id ?? null,
          revision: ticket.revision ?? null,
          response: { approved: true },
        },
      },
      context,
    );
    assert.equal(responded.kind, 'completed');
    const terminal = await completed;
    assert.ok(isJsonObject(terminal.payload));
    assert.equal(terminal.payload.phase, 'succeeded');
  } finally {
    await car.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForPhase(
  car: Awaited<ReturnType<typeof openCar>>,
  phase: string,
  context: Contracts.InvocationContext,
) {
  const watched = await car.hub.watch({ ...context, signal: AbortSignal.timeout(15_000) });
  assert.ok(watched.ok);
  try {
    for (const item of watched.value.bootstrap.items)
      if (isJsonObject(item.payload) && item.payload.phase === phase) return item;
    for await (const frame of watched.value.frames) {
      if (frame.kind !== 'event' || frame.event.type !== 'part.item/upsert') continue;
      const item = frame.event.payload;
      if (isJsonObject(item) && isJsonObject(item.payload) && item.payload.phase === 'failed')
        throw new Error(`Workflow failed: ${JSON.stringify(item.payload)}`);
      if (isJsonObject(item) && isJsonObject(item.payload) && item.payload.phase === phase) {
        const projected = car.hub.snapshot().items.find((entry) => entry.id === item.id);
        assert.ok(projected);
        return projected;
      }
    }
    throw new Error(`Workflow never reached ${phase}`);
  } finally {
    await watched.value.close();
  }
}
