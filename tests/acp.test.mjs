// @ts-check
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { startAcpStdio } from '@slop-lab/part-node/acp/index.js';
import { connectAcpMcpServers } from '@slop-lab/part-node/acp/mcp.js';
import { createAcpAgent } from '@slop-lab/part-plugins/acp/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { emptyCleanup, ok, schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { byteStream } from '../examples/acp/streams.mjs';
import { deferred, expectProperty, present } from '../fixtures/assertions.mjs';

const textSchema = schema(
  'acp/text',
  /** @param {unknown} value @returns {value is {text: string}} */ (value) =>
    value !== null &&
    typeof value === 'object' &&
    'text' in value &&
    typeof value.text === 'string',
);
const parameters = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
/** @param {import("@agentclientprotocol/sdk").ClientContext} cx */
const initialize = (cx) =>
  cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
/** @param {import("@agentclientprotocol/sdk").ClientContext} cx */
const newSession = (cx) =>
  cx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
/** @param {import("@agentclientprotocol/sdk").ClientContext} cx @param {string} sessionId @param {string} text */
const prompt = (cx, sessionId, text = 'hello') =>
  cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
/** @param {string[]} executions @param {import('@slop-lab/part/reference/index.js').Tools.Definition<unknown, unknown>['effects']} [effects] */
function toolOptions(executions, effects = 'write') {
  return {
    model: fakeModel([
      { toolCalls: [{ name: 'save_note', arguments: { text: 'hello' } }] },
      { text: 'Saved.' },
    ]),
    tools: [
      functionTool({
        id: 'save_note',
        description: 'Save a note',
        effects,
        input: textSchema,
        output: stringSchema,
        execute: ({ text }) => {
          executions.push(text);
          return text;
        },
      }),
    ],
    toolSchemas: { save_note: parameters },
  };
}
/** @param {{configureSession: import('@slop-lab/part-plugins/acp/index.js').AcpAgentOptions['configureSession'], permission?: (params: import('@agentclientprotocol/sdk').RequestPermissionRequest, signal: AbortSignal) => import('@agentclientprotocol/sdk').RequestPermissionResponse | Promise<import('@agentclientprotocol/sdk').RequestPermissionResponse>, options?: Partial<import('@slop-lab/part-plugins/acp/index.js').AcpAgentOptions>, transport?: Partial<Parameters<typeof startAcpStdio>[0]>}} settings
 * @param {(cx: import("@agentclientprotocol/sdk").ClientContext, state: {updates: import("@agentclientprotocol/sdk").SessionNotification[], requests: import("@agentclientprotocol/sdk").RequestPermissionRequest[], host: ReturnType<typeof startAcpStdio>}) => Promise<void>} run
 */
async function withSdk(
  {
    configureSession,
    permission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    options = {},
    transport = {},
  },
  run,
) {
  const input = new PassThrough(),
    output = new PassThrough(),
    /** @type {import("@agentclientprotocol/sdk").SessionNotification[]} */
    updates = [],
    /** @type {import("@agentclientprotocol/sdk").RequestPermissionRequest[]} */
    requests = [];
  const host = startAcpStdio({
    ...transport,
    input,
    output,
    createHandler: (connection) => createAcpAgent({ ...options, connection, configureSession }),
  });
  try {
    await client({ name: 'part-conformance' })
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        requests.push(ctx.params);
        return permission(ctx.params, ctx.signal);
      })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      })
      .connectWith(ndJsonStream(Writable.toWeb(input), byteStream(output)), (cx) =>
        run(cx, { updates, requests, host }),
      );
  } finally {
    await host.close();
    output.destroy();
  }
}

test('Official ACP SDK initializes, receives text and embedded context, and preserves isolated session histories', async () => {
  /** @type {ReturnType<typeof fakeModel>[]} */
  const models = [],
    /** @type {import("@slop-lab/part-plugins/acp/index.js").AcpSessionSetup[]} */
    setups = [];
  await withSdk(
    {
      configureSession(setup) {
        setups.push(setup);
        const model = fakeModel([{ text: 'Hello ☃' }, { text: 'Follow-up' }]);
        models.push(model);
        return { model };
      },
    },
    async (cx, { updates }) => {
      const info = await initialize(cx);
      assert.equal(info.protocolVersion, 1);
      assert.equal(present(info.agentCapabilities).loadSession, false);
      assert.equal(present(present(info.agentCapabilities).promptCapabilities).image, false);
      const first = await newSession(cx),
        second = await newSession(cx);
      assert.notEqual(first.sessionId, second.sessionId);
      assert.equal((await prompt(cx, first.sessionId)).stopReason, 'end_turn');
      const streamed = updates
        .filter((item) => item.sessionId === first.sessionId)
        .map(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
            ? update.content.text
            : '',
        )
        .join('');
      assert.equal(streamed, 'Hello ☃');
      await cx.request(methods.agent.session.prompt, {
        sessionId: first.sessionId,
        prompt: [
          {
            type: 'resource',
            resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'Embedded note' },
          },
        ],
      });
      /** @type {{content: string}[]} */
      const history = JSON.parse(
        new TextDecoder().decode(present(present(models[0]).requests[1]).body),
      ).messages;
      assert.equal(present(history[0]).content, 'hello');
      assert.equal(present(history[1]).content, 'Hello ☃');
      assert.match(present(history[2]).content, /Embedded note/);
      await prompt(cx, second.sessionId, 'isolated');
      assert.equal(
        JSON.parse(new TextDecoder().decode(present(present(models[1]).requests[0]).body)).messages
          .length,
        1,
      );
      assert.equal(present(setups[0]).cwd, process.cwd());
    },
  );
});

test('Official SDK permission decisions gate writes and produce stable tool call transitions', async () => {
  for (const choice of ['allow-once', 'reject-once', 'unexpected']) {
    /** @type {string[]} */
    const executions = [];
    await withSdk(
      {
        configureSession: () => toolOptions(executions),
        permission: () => ({ outcome: { outcome: 'selected', optionId: choice } }),
      },
      async (cx, { updates, requests }) => {
        await initialize(cx);
        const session = await newSession(cx);
        if (choice === 'allow-once')
          assert.equal((await prompt(cx, session.sessionId)).stopReason, 'end_turn');
        else
          await assert.rejects(
            prompt(cx, session.sessionId),
            (error) =>
              expectProperty(error, 'code') === -32603 &&
              expectProperty(expectProperty(error, 'data'), 'code') === 'part.acp.denied',
          );
        assert.deepEqual(executions, choice === 'allow-once' ? ['hello'] : []);
        assert.equal(requests.length, 1);
        assert.equal(present(present(requests[0]).options[0]).kind, 'allow_once');
        const tools = updates.map((item) => item.update).filter((item) => 'toolCallId' in item);
        assert.equal(new Set(tools.map((item) => item.toolCallId)).size, 1);
        assert.deepEqual(
          tools.map((item) => item.status),
          choice === 'allow-once' ? ['pending', 'in_progress', 'completed'] : ['pending', 'failed'],
        );
      },
    );
  }
});

test('ACP cancellation releases an unanswered permission request; late allow cannot execute the tool', async () => {
  /** @type {string[]} */
  const executions = [],
    asked =
      /** @type {PromiseWithResolvers<import("@agentclientprotocol/sdk").RequestPermissionRequest>} */ (
        deferred()
      ),
    decision =
      /** @type {PromiseWithResolvers<import("@agentclientprotocol/sdk").RequestPermissionResponse>} */ (
        deferred()
      );
  await withSdk(
    {
      configureSession: () => toolOptions(executions),
      permission(params) {
        assert.ok(asked.resolve);
        asked.resolve(params);
        return decision.promise;
      },
    },
    async (cx, { updates }) => {
      await initialize(cx);
      const session = await newSession(cx);
      const pending = prompt(cx, session.sessionId);
      await asked.promise;
      await assert.rejects(
        prompt(cx, session.sessionId),
        (error) => expectProperty(error, 'code') === -32000,
      );
      await cx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      assert.equal((await pending).stopReason, 'cancelled');
      assert.ok(decision.resolve);
      decision.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      await setTimeout(10);
      assert.deepEqual(executions, []);
      assert.ok(updates.some((item) => 'status' in item.update && item.update.status === 'failed'));
      assert.equal((await prompt(cx, session.sessionId, 'continue')).stopReason, 'end_turn');
    },
  );
});

test('ACP read tools skip permission by default and all-tools policy requests it', async () => {
  for (const permissions of /** @type {const} */ (['writes', 'all'])) {
    /** @type {string[]} */
    const executions = [];
    await withSdk(
      { configureSession: () => toolOptions(executions, 'read'), options: { permissions } },
      async (cx, { requests }) => {
        await initialize(cx);
        const session = await newSession(cx);
        await prompt(cx, session.sessionId);
        assert.equal(requests.length, permissions === 'all' ? 1 : 0);
        assert.deepEqual(executions, ['hello']);
      },
    );
  }
});

test('ACP fails unsupported inputs and bounded admission before model execution', async () => {
  /** @type {ReturnType<typeof fakeModel>[]} */
  const models = [];
  await withSdk(
    {
      configureSession() {
        const model = fakeModel([{ text: 'ok' }]);
        models.push(model);
        return { model };
      },
      options: { maxSessions: 1, maxHistoryTurns: 1, maxPromptBytes: 16 },
    },
    async (cx) => {
      await assert.rejects(newSession(cx), (error) => expectProperty(error, 'code') === -32600);
      const init = await cx.request(methods.agent.initialize, {
        protocolVersion: 2,
        clientCapabilities: {},
      });
      assert.equal(init.protocolVersion, 1);
      await assert.rejects(initialize(cx), (error) => expectProperty(error, 'code') === -32602);
      await assert.rejects(
        cx.request(methods.agent.session.new, { cwd: 'relative', mcpServers: [] }),
        (error) => expectProperty(error, 'code') === -32602,
      );
      await assert.rejects(
        cx.request(methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: [],
          additionalDirectories: ['/other'],
        }),
        (error) => expectProperty(error, 'code') === -32602,
      );
      await assert.rejects(
        cx.request(methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: [{ name: 'uninstalled', command: 'anything', args: [], env: [] }],
        }),
        (error) => expectProperty(error, 'code') === -32602,
      );
      const session = await newSession(cx);
      await assert.rejects(newSession(cx), (error) => expectProperty(error, 'code') === -32000);
      await assert.rejects(
        prompt(cx, 'unknown'),
        (error) => expectProperty(error, 'code') === -32602,
      );
      await assert.rejects(
        prompt(cx, session.sessionId, 'x'.repeat(17)),
        (error) => expectProperty(error, 'code') === -32602,
      );
      await assert.rejects(
        cx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }],
        }),
        (error) => expectProperty(error, 'code') === -32602,
      );
      assert.equal(present(models[0]).requests.length, 0);
      await prompt(cx, session.sessionId, 'valid');
      await assert.rejects(
        prompt(cx, session.sessionId),
        (error) => expectProperty(error, 'code') === -32000,
      );
      await assert.rejects(
        cx.request(methods.agent.session.load, {
          sessionId: session.sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        }),
        (error) => expectProperty(error, 'code') === -32601,
      );
    },
  );
});

test('ACP permission timeout fails closed and cancel notifications bypass request capacity', async () => {
  for (const timeout of [false, true]) {
    /** @type {string[]} */
    const executions = [],
      asked = deferred(),
      decision =
        /** @type {PromiseWithResolvers<import("@agentclientprotocol/sdk").RequestPermissionResponse>} */ (
          deferred()
        );
    await withSdk(
      {
        configureSession: () => toolOptions(executions),
        transport: { maxConcurrentRequests: 1, requestTimeoutMs: timeout ? 30 : 1000 },
        permission() {
          assert.ok(asked.resolve);
          asked.resolve();
          return decision.promise;
        },
      },
      async (cx) => {
        await initialize(cx);
        const session = await newSession(cx),
          pending = prompt(cx, session.sessionId);
        await asked.promise;
        if (timeout)
          await assert.rejects(
            pending,
            (error) =>
              expectProperty(expectProperty(error, 'data'), 'code') === 'part.acp.permission',
          );
        else {
          await assert.rejects(newSession(cx), (error) => expectProperty(error, 'code') === -32000);
          await cx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
          assert.equal((await pending).stopReason, 'cancelled');
        }
        assert.ok(decision.resolve);
        decision.resolve({ outcome: { outcome: 'cancelled' } });
        assert.deepEqual(executions, []);
      },
    );
  }
});

test('Closing ACP during async session setup aborts its host signal and awaits cleanup', async () => {
  const configured =
      /** @type {PromiseWithResolvers<import("@slop-lab/part-plugins/acp/index.js").AcpSessionSetup>} */ (
        deferred()
      ),
    release = deferred();
  const agent = createAcpAgent({
    connection: {
      async notify() {},
      async request() {
        return null;
      },
    },
    async configureSession(setup) {
      assert.ok(configured.resolve);
      configured.resolve(setup);
      await release.promise;
      return { model: fakeModel([{ text: 'unused' }]) };
    },
  });
  await agent.handle('initialize', { protocolVersion: 1 });
  const pending = agent.handle('session/new', { cwd: process.cwd(), mcpServers: [] });
  const setup = await configured.promise;
  const rejected = assert.rejects(pending, (error) => expectProperty(error, 'code') === -32600);
  const closed = agent.close();
  assert.equal(setup.signal.aborted, true);
  assert.ok(release.resolve);
  release.resolve();
  assert.deepEqual((await closed).unresolved, []);
  await rejected;
});

test('ACP request ID reuse during output backpressure preserves the new request cancellation signal', async () => {
  const input = new PassThrough(),
    writing = deferred(),
    started = deferred(),
    cancelled = deferred();
  /** @type {((error?: Error | null) => void) | undefined} */
  let release;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      release = callback;
      assert.ok(writing.resolve);
      writing.resolve();
    },
  });
  const host = startAcpStdio({
    input,
    output,
    createHandler: () => ({
      async handle(method, _params, _kind, signal) {
        if (method === 'second') {
          assert.ok(cancelled.resolve);
          present(signal).addEventListener('abort', () => cancelled.resolve(), { once: true });
          assert.ok(started.resolve);
          started.resolve();
          await cancelled.promise;
        }
        return {};
      },
      async close() {
        return emptyCleanup();
      },
    }),
  });
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'first' }) + '\n');
    await writing.promise;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'second' }) + '\n');
    await started.promise;
    present(release)();
    await setTimeout(0);
    input.write(
      JSON.stringify({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 1 } }) +
        '\n',
    );
    await Promise.race([
      cancelled.promise,
      setTimeout(1000).then(() => {
        throw Error('Reused request lost its cancellation signal');
      }),
    ]);
  } finally {
    await host.close();
  }
});

/** @param {Partial<Parameters<typeof startAcpStdio>[0]>} options */
function rawHost(options = {}) {
  const input = new PassThrough(),
    output = new PassThrough(),
    /** @type {Record<string, import("@slop-lab/part/reference/index.js").Contracts.Json>[]} */
    messages = [],
    /** @type {((value: Record<string, import("@slop-lab/part/reference/index.js").Contracts.Json>) => void)[]} */
    waiters = [];
  let buffered = '';
  output.on('data', (chunk) => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n');
      /** @type {Record<string, import("@slop-lab/part/reference/index.js").Contracts.Json>} */
      const value = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      messages.push(value);
      waiters.shift()?.(value);
    }
  });
  const host = startAcpStdio({
    input,
    output,
    createHandler: () => ({
      async handle(_method, params) {
        return params;
      },
      async close() {
        return emptyCleanup();
      },
    }),
    ...options,
  });
  return {
    host,
    input,
    output,
    messages,
    next() {
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

test('ACP NDJSON handles byte-split Unicode, malformed JSON, invalid envelopes and trailing EOF', async () => {
  const raw = rawHost();
  try {
    const reply = raw.next(),
      bytes = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { text: 'snowman ☃' } }) +
          '\r\n',
      );
    for (const byte of bytes) raw.input.write(Buffer.from([byte]));
    assert.equal((await reply).result.text, 'snowman ☃');
    const malformed = raw.next();
    raw.input.write('{broken}\n');
    assert.equal((await malformed).error.code, -32700);
    const invalid = raw.next();
    raw.input.write('[]\n');
    assert.equal((await invalid).error.code, -32600);
    const eof = raw.next();
    raw.input.end('{');
    assert.equal((await eof).error.code, -32700);
    assert.deepEqual((await raw.host.closed).unresolved, []);
  } finally {
    await raw.host.close();
    raw.output.destroy();
  }
});

test('ACP transport bounds oversized frames and releases stalled output during close', async () => {
  const raw = rawHost({ maxFrameBytes: 16 });
  raw.input.write('x'.repeat(17));
  assert.equal(present((await raw.host.closed).errors[0]).code, 'part.acp.input');
  raw.output.destroy();
  const input = new PassThrough(),
    output = new Writable({ write() {} });
  const host = startAcpStdio({
    input,
    output,
    createHandler: () => ({
      async handle() {
        return {};
      },
      async close() {
        return emptyCleanup();
      },
    }),
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"wait","params":{}}\n');
  await setTimeout(5);
  assert.deepEqual((await host.close()).unresolved, []);
  output.destroy();
});

test('The ACP example interoperates with the official SDK over actual child-process stdio', async () => {
  const child = spawn(process.execPath, ['examples/acp/agent.mjs'], {
    env: { ...process.env, PART_ACP_PROVIDER: 'scripted' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await client({ name: 'part-subprocess-conformance' })
      .onNotification(methods.client.session.update, () => {})
      .onRequest(methods.client.session.requestPermission, () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }))
      .connectWith(
        ndJsonStream(Writable.toWeb(child.stdin), byteStream(child.stdout)),
        async (cx) => {
          await initialize(cx);
          const session = await newSession(cx);
          assert.equal((await prompt(cx, session.sessionId)).stopReason, 'end_turn');
          assert.equal((await prompt(cx, session.sessionId, 'save a note')).stopReason, 'end_turn');
        },
      );
    child.stdin.end();
    assert.equal((await exited)[0], 0);
    assert.equal(stderr, '');
  } finally {
    child.kill('SIGTERM');
  }
});

test('ACP session close cancels outstanding permission work and releases session capacity', async () => {
  /** @type {string[]} */
  const executions = [],
    asked = deferred(),
    permission =
      /** @type {PromiseWithResolvers<import("@agentclientprotocol/sdk").RequestPermissionResponse>} */ (
        deferred()
      );
  await withSdk(
    {
      configureSession: () => toolOptions(executions),
      options: { maxSessions: 1 },
      permission() {
        assert.ok(asked.resolve);
        asked.resolve();
        return permission.promise;
      },
    },
    async (cx) => {
      const info = await initialize(cx);
      assert.deepEqual(present(present(info.agentCapabilities).sessionCapabilities).close, {});
      const session = await newSession(cx),
        pending = prompt(cx, session.sessionId);
      await asked.promise;
      assert.deepEqual(
        await cx.request(methods.agent.session.close, { sessionId: session.sessionId }),
        {},
      );
      assert.equal((await pending).stopReason, 'cancelled');
      assert.deepEqual(executions, []);
      assert.ok(permission.resolve);
      permission.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      await assert.rejects(
        prompt(cx, session.sessionId),
        (error) => expectProperty(error, 'code') === -32602,
      );
      assert.notEqual((await newSession(cx)).sessionId, session.sessionId);
    },
  );
});

test('ACP stdio MCP servers install dispatcher tools, require permission and report unknown remote effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'part-acp-mcp-'));
  const old = process.env.PART_MCP_NOT_INHERITED;
  process.env.PART_MCP_NOT_INHERITED = 'test-secret-never-inherited';
  try {
    for (const decision of ['allow-once', 'reject-once']) {
      const marker = join(directory, decision),
        /** @type {Awaited<ReturnType<typeof connectAcpMcpServers>>[]} */
        connections = [],
        /** @type {ReturnType<typeof fakeModel>[]} */
        models = [];
      await withSdk(
        {
          options: {
            connectMcp: async (setup) => {
              const connected = await connectAcpMcpServers({
                ...setup,
                allowServer: (server) => server.command === process.execPath,
              });
              connections.push(connected);
              return connected;
            },
          },
          configureSession() {
            const model = fakeModel([
              { toolCalls: [{ name: 'mcp_0_0_echo', arguments: { text: 'hello' } }] },
              { text: 'Remote tool complete.' },
            ]);
            models.push(model);
            return { model };
          },
          permission: () => ({ outcome: { outcome: 'selected', optionId: decision } }),
        },
        async (cx, { updates, requests }) => {
          await initialize(cx);
          const session = await cx.request(methods.agent.session.new, {
            cwd: directory,
            mcpServers: [
              {
                name: 'fixture',
                command: process.execPath,
                args: [fileURLToPath(new URL('../fixtures/acp/mcp-server.mjs', import.meta.url))],
                env: [{ name: 'PART_MCP_MARKER', value: marker }],
              },
            ],
          });
          if (decision === 'allow-once') {
            assert.equal((await prompt(cx, session.sessionId)).stopReason, 'end_turn');
            assert.equal(await readFile(marker, 'utf8'), 'called\n');
            /** @type {{messages: {content: string}[]}} */
            const history = JSON.parse(
              new TextDecoder().decode(present(present(models[0]).requests[1]).body),
            );
            assert.match(present(history.messages.at(-1)).content, /HELLO/);
            assert.match(present(history.messages.at(-1)).content, /"hostSecretPresent":false/);
            assert.ok(
              updates.some(
                (item) =>
                  'rawOutput' in item.update &&
                  expectProperty(item.update.rawOutput, 'effect') === 'unknown',
              ),
            );
          } else {
            await assert.rejects(
              prompt(cx, session.sessionId),
              (error) =>
                expectProperty(expectProperty(error, 'data'), 'code') === 'part.acp.denied',
            );
            await assert.rejects(
              readFile(marker),
              (error) => expectProperty(error, 'code') === 'ENOENT',
            );
          }
          assert.equal(requests.length, 1); // Untrusted readOnlyHint never bypasses permission.
          await cx.request(methods.agent.session.close, { sessionId: session.sessionId });
          assert.deepEqual((await present(connections[0]).close()).unresolved, []);
        },
      );
    }
  } finally {
    if (old === undefined) delete process.env.PART_MCP_NOT_INHERITED;
    else process.env.PART_MCP_NOT_INHERITED = old;
    await rm(directory, { recursive: true, force: true });
  }
});

test('ACP MCP launch policy rejects unauthorized commands before starting a server', async () => {
  await assert.rejects(
    connectAcpMcpServers({
      cwd: process.cwd(),
      mcpServers: [{ name: 'denied', command: process.execPath, args: [], env: [] }],
      allowServer: () => false,
    }),
    /MCP session setup failed/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    connectAcpMcpServers({
      cwd: process.cwd(),
      signal: abort.signal,
      mcpServers: [{ name: 'cancelled', command: process.execPath, args: [], env: [] }],
      allowServer: () => true,
    }),
    /MCP session setup failed/,
  );
});

test('Official SDK request cancellation cancels the permission UI without accepting a late decision', async () => {
  const asked = deferred(),
    dismissed = deferred(),
    /** @type {string[]} */
    executions = [];
  await withSdk(
    {
      configureSession: () => toolOptions(executions),
      permission(_params, signal) {
        assert.ok(asked.resolve);
        asked.resolve();
        return new Promise((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              assert.ok(dismissed.resolve);
              dismissed.resolve();
              resolve({ outcome: { outcome: 'cancelled' } });
            },
            { once: true },
          ),
        );
      },
    },
    async (cx) => {
      await initialize(cx);
      const session = await newSession(cx),
        abort = new AbortController();
      const pending = cx.request(
        methods.agent.session.prompt,
        { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'cancel this request' }] },
        { cancellationSignal: abort.signal },
      );
      await asked.promise;
      abort.abort();
      assert.equal((await pending).stopReason, 'cancelled');
      await dismissed.promise;
      assert.deepEqual(executions, []);
    },
  );
});

test('ACP output timeout closes a stalled peer instead of hanging a turn indefinitely', async () => {
  const input = new PassThrough(),
    output = new Writable({ write() {} });
  const host = startAcpStdio({
    input,
    output,
    writeTimeoutMs: 10,
    createHandler: () => ({
      async handle() {
        return {};
      },
      async close() {
        return emptyCleanup();
      },
    }),
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"wait","params":{}}\n');
  const report = await host.closed;
  assert.equal(present(report.errors[0]).code, 'part.acp.output');
  output.destroy();
});

test('ACP retains incomplete cleanup evidence from failed session setup', async () => {
  const unresolved = [{ owner: 'test', kind: 'resource', id: 'not-released' }];
  const agent = createAcpAgent({
    connection: {
      async notify() {},
      async request() {
        return null;
      },
    },
    async connectMcp() {
      return {
        tools: [],
        toolSchemas: {},
        executors: [],
        async close() {
          return { released: [], unresolved, errors: [] };
        },
      };
    },
    configureSession() {
      throw Error('private host configuration error');
    },
  });
  await agent.handle('initialize', { protocolVersion: 1 });
  await assert.rejects(
    agent.handle('session/new', {
      cwd: process.cwd(),
      mcpServers: [{ name: 'provided', command: process.execPath, args: [], env: [] }],
    }),
    (error) =>
      expectProperty(error, 'code') === -32603 &&
      !String(expectProperty(error, 'message')).includes('private'),
  );
  assert.deepEqual((await agent.close()).unresolved, unresolved);
});

test('ACP tool IDs remain distinct when a provider reuses its call ID across prompt turns', async () => {
  /** @type {string[]} */
  const executions = [];
  await withSdk(
    {
      configureSession() {
        const options = toolOptions(executions);
        options.model = fakeModel([
          { toolCalls: [{ name: 'save_note', arguments: { text: 'one' } }] },
          { text: 'one saved' },
          { toolCalls: [{ name: 'save_note', arguments: { text: 'two' } }] },
          { text: 'two saved' },
        ]);
        const original = options.model.adapter;
        options.model = {
          ...options.model,
          adapter: {
            ...original,
            /** @param {Parameters<typeof original.createDecoder>[0]} response */
            createDecoder(response) {
              const created = original.createDecoder(response);
              return created.ok
                ? ok({
                    ...created.value,
                    finish() {
                      const decoded = created.value.finish();
                      return decoded.ok
                        ? ok({
                            ...decoded.value,
                            toolCalls: decoded.value.toolCalls.map((call) => ({
                              ...call,
                              id: 'provider-reused-id',
                            })),
                          })
                        : decoded;
                    },
                  })
                : created;
            },
          },
        };
        return options;
      },
    },
    async (cx, { updates }) => {
      await initialize(cx);
      const session = await newSession(cx);
      await prompt(cx, session.sessionId, 'one');
      await prompt(cx, session.sessionId, 'two');
      const ids = updates
        .filter((item) => item.update.sessionUpdate === 'tool_call')
        .map((item) => expectProperty(item.update, 'toolCallId'));
      assert.equal(ids.length, 2);
      assert.notEqual(ids[0], ids[1]);
      assert.deepEqual(executions, ['one', 'two']);
    },
  );
});
