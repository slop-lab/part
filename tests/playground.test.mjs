import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaygroundSession } from '../examples/playground/runtime.mjs';
import { localContext } from '@part/core/contracts';

const command = (actionId, input = null, target) => ({
  protocolVersion: 1,
  commandId: crypto.randomUUID(),
  actionId,
  actionVersion: 1,
  input,
  ...(target ? { target } : {}),
});
const start = (session, scenario, prompt = 'hello') =>
  session.endpoint.command(command('part.run/start', { scenario, provider: 'scripted', prompt }));
async function until(read, predicate, label) {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
const ended = (session) =>
  until(
    () => session.state(),
    (state) => !state.active,
    'run completion',
  );
const waiting = (session) =>
  until(
    () => session.state(),
    (state) => state.runs.at(-1)?.approval,
    'approval',
  );

test('Playground uses real tool dispatch, exact request digests and bounded conversation context', async () => {
  const session = createPlaygroundSession({ delayScale: 0 });
  try {
    const request = command('part.run/start', {
      scenario: 'tools',
      provider: 'scripted',
      prompt: 'hello',
    });
    const [first, duplicate] = await Promise.all([
      session.endpoint.command(request),
      session.endpoint.command(request),
    ]);
    assert.deepEqual(first, duplicate);
    const state = await ended(session),
      run = state.runs[0];
    assert.equal(state.runs.length, 1);
    assert.equal(run.phase, 'completed');
    assert.equal(run.events.filter((event) => event.kind === 'tool-start').length, 1);
    const requests = run.events.filter((event) => event.kind === 'request');
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].data.digest,
      run.events.find((event) => event.kind === 'inspection').data.actualDigest,
    );
    assert.equal(requests[1].data.body.messages.at(-1).role, 'tool');
    assert.equal(requests[1].data.body.messages.at(-1).content, '"HELLO"');
    assert.equal(
      (
        await session.endpoint.command({
          ...request,
          input: { ...request.input, prompt: 'different' },
        })
      ).kind,
      'rejected',
    );
    await start(session, 'conversation', 'next turn');
    const next = (await ended(session)).runs.at(-1).events.find((event) => event.kind === 'request')
      .data.body.messages;
    assert.ok(
      next.some((message) => message.role === 'assistant' && message.content.includes('HELLO')),
    );
  } finally {
    await session.close();
  }
});

test('Playground approval writes only after owner approval; rejection and cancellation prevent writes', async () => {
  const session = createPlaygroundSession({
    delayScale: 0,
    context: localContext({
      principal: { subject: 'browser-owner', authority: 'part/playground' },
    }),
  });
  try {
    for (const action of ['playground/reject', 'part.run/cancel', 'playground/approve']) {
      const receipt = await start(session, 'approval', action);
      assert.equal(receipt.kind, 'accepted');
      await waiting(session);
      assert.equal(session.state().note, '');
      assert.equal((await start(session, 'tools')).kind, 'rejected');
      assert.equal(
        (
          await session.endpoint.command(
            command('playground/approve', null, { ...receipt.operation, id: 'stale' }),
          )
        ).kind,
        'rejected',
      );
      const decision = command(action, null, receipt.operation);
      assert.equal((await session.endpoint.command(decision)).kind, 'completed');
      assert.equal((await session.endpoint.command(decision)).kind, 'completed');
      const state = await ended(session),
        run = state.runs.at(-1);
      assert.equal(state.note, action === 'playground/approve' ? action : '');
      assert.equal(
        run.events.filter((event) => event.kind === 'tool-start').length,
        action === 'playground/approve' ? 1 : 0,
      );
      assert.equal(
        run.phase,
        action === 'playground/approve'
          ? 'completed'
          : action === 'part.run/cancel'
            ? 'cancelled'
            : 'failed',
      );
    }
  } finally {
    await session.close();
  }
});

test('Playground validation blocks the executor and report artifacts remain session-owned', async () => {
  const session = createPlaygroundSession({ delayScale: 0 }),
    other = createPlaygroundSession({ delayScale: 0 });
  try {
    await start(session, 'failure');
    const failed = (await ended(session)).runs.at(-1);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.events.filter((event) => event.kind === 'tool-start').length, 0);
    await start(session, 'artifact', 'A small report');
    await ended(session);
    const report = session.hub.snapshot().items.find((item) => item.type === 'playground/report');
    assert.ok(report);
    const content = await session.artifact(report.artifacts[0].id);
    assert.match(content.bytes.toString(), /A small report/);
    assert.equal(await other.artifact(report.artifacts[0].id), null);
    assert.equal((await session.endpoint.command(command('playground/clear'))).kind, 'completed');
    assert.equal(session.state().runs.length, 0);
    assert.equal(await session.artifact(report.artifacts[0].id), null);
  } finally {
    await Promise.all([session.close(), other.close()]);
  }
});

test('Closing observation keeps playground work alive; shutdown cancels the owner and clears waits', async () => {
  const session = createPlaygroundSession({ delayScale: 0 });
  const watcher = await session.endpoint.watch({ surface: 'test' }, localContext());
  await start(session, 'approval');
  await waiting(session);
  await watcher.value.close();
  assert.equal(session.state().runs.at(-1).phase, 'waiting');
  await session.close();
  assert.equal(session.state().runs.at(-1).phase, 'cancelled');
  assert.equal(session.state().runs.at(-1).approval, null);
  assert.equal(session.state().note, '');
});
