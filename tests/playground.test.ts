import { localContext } from '@slop-lab/part/contracts/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaygroundSession } from '../examples/playground/runtime.mjs';
import { deferred, expectProperty, present } from '../fixtures/assertions.mjs';
import type { Contracts } from '@slop-lab/part/reference/index.js';
import type { TraceEvent } from '../examples/playground/runtime.mjs';

const command = <T = null>(
  actionId: string,
  input: T = null as T,
  target?: Contracts.EntityRef,
) => ({
  protocolVersion: 1,
  commandId: crypto.randomUUID(),
  actionId,
  actionVersion: 1,
  input,
  ...(target ? { target } : {}),
});
function messages(event: TraceEvent) {
  const body = expectProperty(event.data, 'body');
  const items = expectProperty(body, 'messages');
  assert.ok(Array.isArray(items));
  return items.map((item) => {
    assert.ok(
      item !== null &&
        typeof item === 'object' &&
        'role' in item &&
        typeof item.role === 'string' &&
        'content' in item &&
        typeof item.content === 'string',
    );
    return { role: item.role, content: item.content };
  });
}
const start = (
  session: ReturnType<typeof createPlaygroundSession>,
  scenario: string,
  prompt: string = 'hello',
) =>
  session.endpoint.command(command('part.run/start', { scenario, provider: 'scripted', prompt }));
async function until<T>(read: () => T, predicate: (state: T) => unknown, label: string) {
  for (let i = 0; i < 400; i++) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
const ended = (session: ReturnType<typeof createPlaygroundSession>) =>
  until(
    () => session.state(),
    (state) => !state.active,
    'run completion',
  );
const waiting = (session: ReturnType<typeof createPlaygroundSession>) =>
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
    assert.equal(present(run).phase, 'completed');
    assert.equal(present(run).events.filter((event) => event.kind === 'tool-start').length, 1);
    const requests = present(run).events.filter((event) => event.kind === 'request');
    assert.equal(requests.length, 2);
    assert.equal(
      expectProperty(present(requests[0]).data, 'digest'),
      expectProperty(
        present(present(run).events.find((event) => event.kind === 'inspection')).data,
        'actualDigest',
      ),
    );
    assert.equal(present(messages(present(requests[1])).at(-1)).role, 'tool');
    assert.equal(present(messages(present(requests[1])).at(-1)).content, '"HELLO"');
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
    const next = messages(
      present(
        present((await ended(session)).runs.at(-1)).events.find(
          (event) => event.kind === 'request',
        ),
      ),
    );
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
        present(run).events.filter((event) => event.kind === 'tool-start').length,
        action === 'playground/approve' ? 1 : 0,
      );
      assert.equal(
        present(run).phase,
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
    assert.equal(present(failed).phase, 'failed');
    assert.equal(present(failed).events.filter((event) => event.kind === 'tool-start').length, 0);
    await start(session, 'artifact', 'A small report');
    await ended(session);
    const report = session.hub.snapshot().items.find((item) => item.type === 'playground/report');
    assert.ok(report);
    const content = await session.artifact(present(report.artifacts[0]).id);
    assert.match(present(content).bytes.toString(), /A small report/);
    assert.equal(await other.artifact(present(report.artifacts[0]).id), null);
    assert.equal((await session.endpoint.command(command('playground/clear'))).kind, 'completed');
    assert.equal(session.state().runs.length, 0);
    assert.equal(await session.artifact(present(report.artifacts[0]).id), null);
  } finally {
    await Promise.all([session.close(), other.close()]);
  }
});

test('Closing observation keeps playground work alive; shutdown cancels the owner and clears waits', async () => {
  const session = createPlaygroundSession({ delayScale: 0 });
  const watcher = await session.endpoint.watch({ surface: 'test' }, localContext());
  await start(session, 'approval');
  await waiting(session);
  await expectProperty(watcher, 'value').close();
  assert.equal(present(session.state().runs.at(-1)).phase, 'waiting');
  await session.close();
  assert.equal(present(session.state().runs.at(-1)).phase, 'cancelled');
  assert.equal(present(session.state().runs.at(-1)).approval, null);
  assert.equal(session.state().note, '');
});

test('Playground streams each model call separately and replaces partial text with the verified result', async () => {
  const finish = deferred();
  const encoder = new TextEncoder();
  let requests = 0;
  const frames = (events: unknown[]) =>
    encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const message = (text: string) => ({
    id: 'msg',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  });
  const completion = (output: unknown[]) => ({
    type: 'response.completed',
    response: { id: 'resp', object: 'response', status: 'completed', output },
  });
  const textEvents = (text: string) => [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message(''), status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: 'msg',
      delta: text,
    },
  ];
  const session = createPlaygroundSession({
    environment: { OPENAI_API_KEY: 'inert-key', OPENAI_MODEL: 'fixture' },
    async fetch() {
      const headers = { 'content-type': 'text/event-stream' };
      if (++requests === 1) {
        const preamble = 'Before the tool.';
        const call = {
          id: 'tool',
          type: 'function_call',
          call_id: 'call',
          name: 'uppercase',
          arguments: '{"text":"hello"}',
        };
        return new Response(
          frames([...textEvents(preamble), completion([message(preamble), call])]),
          { headers },
        );
      }
      assert.equal(requests, 2);
      const text = 'Final ☃';
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(frames(textEvents(text)));
            await finish.promise;
            controller.enqueue(frames([completion([message(text)])]));
            controller.close();
          },
        }),
        { headers },
      );
    },
  });
  try {
    const request = command('part.run/start', {
      scenario: 'tools',
      provider: 'responses',
      prompt: 'hello',
    });
    const delivery = await session.endpoint.command(request);
    assert.equal(delivery.kind, 'accepted');
    const stream = await until(
      () => session.hub.snapshot(),
      ({ streamingParts }) => streamingParts.some(({ text }) => text === 'Final ☃'),
      'the second model call delta',
    );
    assert.equal(requests, 2);
    assert.equal(stream.streamingParts.length, 1);
    assert.equal(stream.streamingParts[0]?.offset, 'Final ☃'.length);
    const reconnected = await session.endpoint.watch({ surface: 'chat' }, session.context);
    assert.ok(reconnected.ok);
    assert.deepEqual(reconnected.value.bootstrap.streamingParts, stream.streamingParts);
    await reconnected.value.close();
    finish.resolve();
    const state = await ended(session);
    assert.equal(state.runs[0]?.phase, 'completed');
    assert.equal(state.runs[0]?.text, 'Final ☃');
    assert.deepEqual(session.hub.snapshot().streamingParts, []);
  } finally {
    finish.resolve();
    await session.close();
  }
});
