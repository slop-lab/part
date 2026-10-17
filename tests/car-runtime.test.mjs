// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { localContext } from '@slop-lab/part/contracts/index.js';

test('car persists completed conversation and enforces operator authorization after reopening', async () => {
  const { openCar } = await import('../car/src/runtime.mjs');
  const root = await mkdtemp(join(tmpdir(), 'car-runtime-'));
  const stateDirectory = join(root, 'state');
  const context = localContext({ principal: { subject: 'developer', authority: 'car/local' } });
  let car = await openCar({
    root,
    stateDirectory,
    model: fakeModel([{ text: 'first answer' }]),
    context,
  });
  try {
    const started = await car.agent.start('first question');
    assert.ok(started.ok);
    assert.equal((await started.value.done).phase, 'completed');
    await car.close();
    car = await openCar({
      root,
      stateDirectory,
      model: fakeModel([{ text: 'second answer' }]),
      context,
    });
    const history = await car.endpoint.query(
      { queryId: 'car.history/path', version: 1, input: null },
      context,
    );
    assert.ok(history.ok);
    assert.match(JSON.stringify(history.value), /first question/);
    assert.match(JSON.stringify(history.value), /first answer/);
    const denied = await car.endpoint.query(
      { queryId: 'car.history/path', version: 1, input: null },
      localContext(),
    );
    assert.equal(denied.ok, false);
    const next = await car.agent.generate('second question');
    assert.ok(next.ok);
    assert.equal(next.value.phase, 'completed');
  } finally {
    await car.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('car refuses a second owner of the same state directory', async () => {
  const { openCar } = await import('../car/src/runtime.mjs');
  const root = await mkdtemp(join(tmpdir(), 'car-owner-'));
  const options = { root, stateDirectory: join(root, 'state'), model: fakeModel([{ text: 'ok' }]) };
  const car = await openCar(options);
  try {
    await assert.rejects(openCar(options), /state directory/);
  } finally {
    await car.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CAR host completion command rejects a model stop when its actual process fails', async () => {
  const { openCar } = await import('../car/src/runtime.mjs');
  const root = await mkdtemp(join(tmpdir(), 'car-completion-'));
  const car = await openCar({
    root,
    stateDirectory: join(root, 'state'),
    model: fakeModel([{ text: 'I claim the task is finished' }]),
    completionCommand: ['node', '-e', 'process.exit(7)'],
  });
  try {
    const generated = await car.agent.generate('Finish only after checking');
    assert.ok(generated.ok);
    assert.equal(generated.value.phase, 'failed');
  } finally {
    await car.close();
    await rm(root, { recursive: true, force: true });
  }
});
