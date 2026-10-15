// @ts-check
import { parseObject, parseJSON } from '../fixtures/contracts.mjs';
import {
  createMockProviderClient,
  readFixture,
  readMockSession,
  startMockProvider,
} from '@slop-lab/part-node/testing/mock-provider/index.js';
import { createMockProviderTools } from '@slop-lab/part-node/testing/mock-provider/tools.js';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import { localContext } from '@slop-lab/part/contracts/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createMockFlow } from '../examples/mock-provider/flow.mjs';
import { expectProperty, present, stub } from '../fixtures/assertions.mjs';
/** @param {string} name */
const load = async (name) =>
  parseJSON(await readFile(new URL(`../fixtures/mock-provider/${name}`, import.meta.url), 'utf8'));
const project = { id: 'part/mock-tool-flow' };
const request = { model: 'part-mock', messages: [{ role: 'user', content: 'hello' }] };
/** @type {import('@slop-lab/part-node/testing/mock-provider/index.js').MockReply} */
const answer = { kind: 'completion', content: 'hello' };
/** @param {import("@slop-lab/part-node/testing/mock-provider/index.js").MockSession} session @param {import("@slop-lab/part-node/testing/mock-provider/index.js").MockChatRequest} body @param {AbortSignal} [signal] */
const post = (session, body = request, signal) =>
  fetch(`${session.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
/** @param {import("@slop-lab/part-node/testing/mock-provider/index.js").MockProviderClient} client */
async function pending(client) {
  const records = await client.pending(1000);
  assert.ok(records.length);
  return records[0];
}
/** @param {import("@slop-lab/part/reference/index.js").Tools.Dispatcher} dispatcher @param {string} id @param {import("@slop-lab/part/reference/index.js").Contracts.Json} args */
async function dispatch(dispatcher, id, args) {
  const started = await dispatcher.dispatch(
    {
      logicalCallId: crypto.randomUUID(),
      modelCallId: 'operator',
      toolId: id,
      expectedToolVersion: '1',
      arguments: args,
    },
    localContext(),
  );
  assert.equal(started.ok, true);
  const outcome = await started.value.done;
  assert.equal(outcome.phase, 'completed', JSON.stringify(outcome));
  return outcome.result.value;
}

test('Fixed OpenAI-compatible provider runs the real agent/tool flow and matches the golden transcript', async () => {
  const provider = await startMockProvider({
    mode: 'fixed',
    project,
    fixture: readFixture(await load('tool-flow.fixture.json')),
  });
  const flow = createMockFlow(provider.session);
  try {
    const result = await flow.run();
    provider.verify();
    assert.deepEqual(
      { provider: provider.transcript(), ...result },
      await load('fixed-tool-flow.transcript.json'),
    );
    assert.ok(!JSON.stringify(provider.transcript()).includes(provider.session.apiKey));
  } finally {
    await flow.dispose();
    await provider.close();
  }
});
test('Interactive requests wait for project-bound operator tools; full tool flow matches its transcript', async () => {
  const provider = await startMockProvider({ mode: 'interactive', project });
  const client = createMockProviderClient(provider.session),
    flow = createMockFlow(provider.session);
  const registration = createMockProviderTools(client),
    created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    let settled = false;
    const running = flow.run().finally(() => {
      settled = true;
    });
    const first = await pending(client);
    assert.equal(settled, false);
    assert.deepEqual(present(first).project, project);
    const inspection = await dispatch(created.value, 'mock_provider_inspect', {
      requestId: present(first).id,
    });
    assert.equal(expectProperty(expectProperty(inspection, 'request'), 'model'), 'part-mock');
    await dispatch(created.value, 'mock_provider_respond', {
      requestId: present(first).id,
      decisionId: 'operator/choose-uppercase-tool',
      reply: await load('choose-tool.reply.json'),
    });
    const second = await pending(client);
    assert.equal(expectProperty(present(second).request.messages.at(-1), 'role'), 'tool');
    await dispatch(created.value, 'mock_provider_respond', {
      requestId: present(second).id,
      decisionId: 'operator/summarize-tool-result',
      reply: await load('final.reply.json'),
    });
    const result = await running;
    await client.verify();
    assert.deepEqual(
      { provider: await client.transcript(), ...result },
      await load('interactive-tool-flow.transcript.json'),
    );
  } finally {
    await flow.dispose();
    await provider.close();
  }
});
test('Fixed matching is exact, ordered and sticky on mismatch; unused and exhausted fixtures fail verification', async () => {
  /** @type {import('@slop-lab/part-node/testing/mock-provider/index.js').MockFixture} */
  const fixture = {
    schemaVersion: 1,
    name: 'exact',
    exchanges: [{ id: 'hello', request, reply: answer }],
  };
  const provider = await startMockProvider({ mode: 'fixed', project, fixture });
  try {
    assert.throws(() => provider.verify(), /verification/);
    assert.equal((await post(provider.session, { ...request, temperature: 1 })).status, 409);
    assert.equal(provider.status().remaining, 1);
    const response = await post(provider.session);
    assert.equal((await response.json()).choices[0].message.content, 'hello');
    assert.equal((await post(provider.session)).status, 409);
    assert.throws(() => provider.verify(), /verification/);
    assert.equal(provider.status().failures.length, 2);
  } finally {
    await provider.close();
  }
});
test('Control and model credentials are separate; decisions are correlated and idempotent, not silently replaced', async () => {
  const provider = await startMockProvider({ mode: 'interactive', project });
  const client = createMockProviderClient(provider.session);
  try {
    assert.equal(
      (
        await fetch(`${provider.session.controlURL}/status`, {
          headers: { authorization: `Bearer ${provider.session.apiKey}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${provider.session.baseURL}/models`, {
          headers: { authorization: `Bearer ${provider.session.controlToken}` },
        })
      ).status,
      401,
    );
    const running = post(provider.session);
    const record = await pending(client);
    await assert.rejects(
      // @ts-expect-error Invalid version values must fail runtime validation.
      () => client.respond(record.id, 'decision', { kind: 'completion', content: 7 }),
      /400/,
    );
    const first = await client.respond(present(record).id, 'decision', answer);
    assert.deepEqual(await client.respond(present(record).id, 'decision', answer), first);
    await assert.rejects(
      () => client.respond(present(record).id, 'decision', { ...answer, content: 'changed' }),
      /409/,
    );
    await assert.rejects(() => client.respond(present(record).id, 'different', answer), /409/);
    assert.equal((await (await running).json()).choices[0].message.content, 'hello');
    await client.verify();
    assert.throws(
      () => readMockSession({ ...provider.session, controlURL: 'https://example.com/control' }),
      /loopback/,
    );
  } finally {
    await provider.close();
  }
});
test('Concurrent interactive responses stay with their request IDs; shutdown releases pending requests', async () => {
  const provider = await startMockProvider({ mode: 'interactive', project });
  const client = createMockProviderClient(provider.session);
  try {
    const first = post(provider.session),
      second = post(provider.session, {
        ...request,
        messages: [{ role: 'user', content: 'second' }],
      });
    for (let n = 0; provider.pending().length < 2 && n < 50; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const records = await client.pending();
    assert.equal(records.length, 2);
    await client.respond(present(records[1]).id, 'second', {
      kind: 'completion',
      content: 'second response',
    });
    await client.respond(present(records[0]).id, 'first', answer);
    assert.equal((await (await first).json()).choices[0].message.content, 'hello');
    assert.equal((await (await second).json()).choices[0].message.content, 'second response');
    const third = post(provider.session);
    const record = await pending(client);
    await provider.close();
    assert.equal((await third).status, 503);
    assert.equal(provider.inspect(present(record).id).state, 'closed');
    assert.throws(() => provider.respond(present(record).id, 'late', answer), /closed/);
  } finally {
    await provider.close();
  }
});
test('Disconnect, timeout, capacity and malformed requests remain explicit and cannot be answered late', async () => {
  const provider = await startMockProvider({
    mode: 'interactive',
    project,
    requestTimeoutMs: 100,
    maxPending: 1,
    maxRequests: 3,
  });
  const client = createMockProviderClient(provider.session);
  try {
    const abort = new AbortController(),
      cancelled = post(provider.session, request, abort.signal).catch((error) => error);
    const record = await pending(client);
    abort.abort();
    await cancelled;
    for (let n = 0; provider.inspect(present(record).id).state === 'pending' && n < 50; n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(provider.inspect(present(record).id).state, 'cancelled');
    assert.throws(() => provider.respond(present(record).id, 'late', answer), /cancelled/);
    const timed = post(provider.session);
    const timeoutRecord = await pending(client);
    assert.equal((await post(provider.session)).status, 503);
    assert.equal((await timed).status, 504);
    assert.equal(provider.inspect(present(timeoutRecord).id).state, 'timed-out');
    assert.throws(() => provider.verify(), /verification/);
    assert.equal((await post(provider.session, { ...request, n: 2 })).status, 400);
    assert.equal(
      (
        await fetch(`${provider.session.baseURL}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${provider.session.apiKey}` },
        })
      ).status,
      404,
    );
  } finally {
    await provider.close();
  }
});
test('JSON and SSE replies support function calls and Unicode; malformed or truncated streams fail closed', async () => {
  const adapter = createOpenAICompatibleAdapter();
  /** @param {import("@slop-lab/part/reference/index.js").Contracts.Json} delta @param {string | null} finish_reason */
  const event = (delta, finish_reason = null) => ({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'part-mock',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const data = [
    event({ content: 'snowman ☃' }),
    event({
      tool_calls: [
        {
          index: 0,
          id: 'call',
          type: 'function',
          function: { name: 'uppercase', arguments: '{"text":' },
        },
      ],
    }),
    event({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }, 'tool_calls'),
  ];
  const wire =
    data.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const decoder = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  for (const byte of new TextEncoder().encode(wire))
    assert.equal(decoder.push(Uint8Array.of(byte)).ok, true);
  const result = decoder.finish();
  assert.equal(result.ok, true);
  assert.equal(expectProperty(result.value.content[0], 'text'), 'snowman ☃');
  assert.deepEqual(present(result.value.toolCalls[0]).arguments, { text: 'hello' });
  const partial = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  partial.push(new TextEncoder().encode(wire.replace('data: [DONE]\r\n\r\n', '')));
  assert.equal(partial.finish().ok, false);
  const invalid = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  assert.equal(invalid.push(new TextEncoder().encode('data: {broken}\n\n')).ok, false);
  assert.equal(invalid.finish().ok, false);
  const json = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'application/json' } }),
    'value',
  );
  json.push(
    new TextEncoder().encode(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'json' }, finish_reason: 'stop' },
        ],
      }),
    ),
  );
  assert.equal(expectProperty(expectProperty(json.finish(), 'value').content[0], 'text'), 'json');
  assert.equal(adapter.createDecoder({ status: 429, headers: {} }).ok, false);
});
test('CLI starts a session, exposes pending requests, accepts a chosen reply and exits after stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'part-mock-cli-'));
  const sessionPath = join(directory, 'session.json');
  const cli = resolve('packages/node/dist/testing/mock-provider/cli.js');
  const child = spawn(
    process.execPath,
    [cli, 'serve', '--mode', 'interactive', '--project', 'cli/project', '--session', sessionPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  /** @param {string[]} args */
  const run = async (...args) =>
    parseJSON(
      (await promisify(execFile)(process.execPath, [cli, ...args, '--session', sessionPath]))
        .stdout,
    );
  try {
    let session;
    for (let n = 0; !session && n < 100; n++) {
      try {
        session = readMockSession(parseJSON(await readFile(sessionPath, 'utf8')));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(session, stderr);
    const running = post(session);
    const records = await run('pending', '--wait-ms', '1000');
    assert.ok(Array.isArray(records));
    const record = present(records[0]);
    assert.equal(expectProperty(expectProperty(record, 'project'), 'id'), 'cli/project');
    const id = expectProperty(record, 'id');
    assert.ok(typeof id === 'string');
    await run('respond', '--id', id, '--decision-id', 'cli/answer', '--text', 'chosen by operator');
    assert.equal((await (await running).json()).choices[0].message.content, 'chosen by operator');
    assert.deepEqual(await run('verify'), { ok: true });
    const frozen = await run('fixture');
    const replay = await startMockProvider({
      mode: 'fixed',
      project,
      fixture: readFixture(frozen),
    });
    try {
      assert.equal(
        (await (await post(replay.session)).json()).choices[0].message.content,
        'chosen by operator',
      );
      replay.verify();
    } finally {
      await replay.close();
    }
    await run('stop');
    assert.equal(await exited, 0, stderr);
  } finally {
    child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Fixed fixtures preserve explicit provider errors and malformed wire responses', async () => {
  /** @type {import('@slop-lab/part-node/testing/mock-provider/index.js').MockFixture} */
  const fixture = {
    schemaVersion: 1,
    name: 'errors',
    exchanges: [
      {
        id: 'rate-limit',
        request,
        reply: {
          kind: 'error',
          status: 429,
          message: 'Fixture rate limit',
          code: 'rate_limit_exceeded',
        },
      },
      {
        id: 'malformed-json',
        request,
        reply: { kind: 'raw', status: 200, contentType: 'application/json', body: '{broken' },
      },
    ],
  };
  const provider = await startMockProvider({ mode: 'fixed', project, fixture });
  try {
    const error = await post(provider.session);
    assert.equal(error.status, 429);
    assert.equal((await error.json()).error.code, 'rate_limit_exceeded');
    const malformed = await post(provider.session);
    assert.equal(await malformed.text(), '{broken');
    provider.verify();
  } finally {
    await provider.close();
  }
});
test('Body/output bounds reject invalid decisions without consuming the pending request', async () => {
  const provider = await startMockProvider({
    mode: 'interactive',
    project,
    maxBodyBytes: 512,
    maxResponseBytes: 512,
  });
  const client = createMockProviderClient(provider.session);
  try {
    assert.equal(
      (await post(provider.session, { ...request, extra: 'x'.repeat(1000) })).status,
      400,
    );
    const running = post(provider.session);
    const record = await pending(client);
    assert.throws(
      () =>
        provider.respond(present(record).id, 'large', {
          kind: 'completion',
          content: 'x'.repeat(1000),
        }),
      /byte limit/,
    );
    assert.equal(provider.inspect(present(record).id).state, 'pending');
    await client.respond(present(record).id, 'small', answer);
    assert.equal((await running).status, 200);
    await client.verify();
  } finally {
    await provider.close();
  }
});

test('Non-streaming OpenAI requests omit stream-only options while SSE requests request usage', async () => {
  const adapter = createOpenAICompatibleAdapter();
  for (const stream of [false, true]) {
    const encoded = await adapter.encode(
      { profileId: 'fixture', context: stub({ fragments: [] }), tools: [], options: {} },
      stub({ model: 'part-mock', defaults: { stream } }),
    );
    assert.equal(encoded.ok, true);
    const body = parseObject(new TextDecoder().decode(encoded.value.body));
    assert.equal(body.stream, stream);
    assert.deepEqual(body.stream_options, stream ? { include_usage: true } : undefined);
  }
});

test('OpenAI JSON and SSE accept null tool_calls without accepting malformed non-null calls', () => {
  const adapter = createOpenAICompatibleAdapter();
  for (const streaming of [false, true]) {
    for (const toolCalls of [null, { invalid: true }]) {
      const decoder = expectProperty(
        adapter.createDecoder({
          status: 200,
          headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
        }),
        'value',
      );
      const completion = {
        choices: [
          {
            index: 0,
            [streaming ? 'delta' : 'message']: {
              role: 'assistant',
              content: 'HELLO',
              tool_calls: toolCalls,
            },
            finish_reason: 'stop',
          },
        ],
      };
      const pushed = decoder.push(
        new TextEncoder().encode(
          streaming
            ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`
            : JSON.stringify(completion),
        ),
      );
      const decoded = decoder.finish();
      if (toolCalls === null) {
        assert.equal(pushed.ok, true);
        assert.equal(decoded.ok, true);
        assert.deepEqual(decoded.value.toolCalls, []);
        assert.deepEqual(decoded.value.content, [{ kind: 'text', text: 'HELLO' }]);
      } else {
        assert.equal(decoded.ok, false);
        assert.equal(decoded.error.code, 'part.openai-compatible.tools');
      }
    }
  }
});
