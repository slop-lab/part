// @ts-check
import { startHttpHost } from '@slop-lab/part-node/host/http.js';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createOllamaAdapter } from '@slop-lab/part-plugins/providers/ollama.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { createHttpPort } from '@slop-lab/part/client/http.js';
import { fail, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createEmbeddedEndpoint } from '@slop-lab/part/host/embedded.js';
import { createFetchTransport, noAuth } from '@slop-lab/part/model/index.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { expectProperty, present } from '../fixtures/assertions.mjs';
const context = localContext();
test('G03: provider adapter uses a real HTTP custom endpoint with a local fake response', async () => {
  /** @type {{model: string, messages: {content: string}[]} | undefined} */
  let body;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('content-type', 'application/x-ndjson');
    response.write('{"message":{"content":"local "},"done":false}\n');
    response.end('{"message":{"content":"endpoint"},"done":true,"done_reason":"stop"}\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${expectProperty(server.address(), 'port')}/api/chat`;
  const model = {
    profile: {
      id: 'local',
      revision: '1',
      adapterId: 'part/ollama',
      transportId: 'part/fetch',
      authStrategyId: 'none',
      model: 'fake-model',
      endpoint,
      defaults: {},
      capabilities: { revision: '1', entries: [] },
    },
    adapter: createOllamaAdapter(),
    transport: createFetchTransport({ allowedOrigins: [new URL(endpoint).origin] }),
    auth: noAuth,
  };
  const agent = expectProperty(createAgent({ model }), 'value');
  try {
    const outcome = await agent.generate('local test');
    assert.equal(expectProperty(outcome, 'value').phase, 'completed');
    assert.equal(
      expectProperty(expectProperty(expectProperty(outcome, 'value'), 'result').content[0], 'text'),
      'local endpoint',
    );
    assert.ok(body);
    assert.equal(present(body.messages[0]).content, 'local test');
    assert.ok(body);
    assert.equal(body.model, 'fake-model');
  } finally {
    await agent.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('HTTP/SSE commands, queries, snapshots and owner authentication', async () => {
  const model = fakeModel([{ text: 'over http' }]),
    agent = expectProperty(createAgent({ model }), 'value'),
    endpoint = expectProperty(createEmbeddedEndpoint(agent, { context }), 'value');
  const host = await startHttpHost(endpoint, {
    context: (request) =>
      request.headers.authorization === 'Bearer fixture'
        ? ok(context)
        : fail('auth', 'Unauthorized', 'permission'),
  });
  assert.equal(host.ok, true);
  const port = createHttpPort(host.value.url, {
    headers: () => ({ authorization: 'Bearer fixture' }),
  });
  let watch;
  try {
    const unauthorized = createHttpPort(host.value.url);
    assert.equal(
      (await unauthorized.query({ queryId: 'part/capabilities', version: 1, input: null })).ok,
      false,
    );
    assert.equal((await port.discover()).ok, true);
    watch = expectProperty(await port.watch({ surface: 'chat' }), 'value');
    assert.equal(watch.bootstrap.items.length, 0);
    const iterator = watch.frames[Symbol.asyncIterator]();
    const pending = iterator.next();
    const delivered = await port.command({
      protocolVersion: 1,
      commandId: 'http-start',
      actionId: 'part.run/start',
      actionVersion: 1,
      input: 'hello',
    });
    assert.equal(expectProperty(delivered, 'receipt').kind, 'accepted');
    const first = await pending;
    assert.equal(first.value.kind, 'event');
    assert.equal(first.value.event.type, 'part.item/upsert');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const run = await port.query({
      queryId: 'part.run/get',
      version: 1,
      input: present(expectProperty(expectProperty(delivered, 'receipt'), 'operation')).id,
    });
    assert.equal(expectProperty(expectProperty(run, 'value'), 'phase'), 'completed');
    await watch.close();
    assert.ok(iterator.return);
    await iterator.return();
  } finally {
    await watch?.close();
    await host.value.close();
    await endpoint.close();
  }
});
