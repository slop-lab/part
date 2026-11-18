// @ts-check
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { startAcpStdio } from '@slop-lab/part-node/acp/index.js';
import { connectAcpMcpServers } from '@slop-lab/part-node/acp/mcp.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { emptyCleanup } from '@slop-lab/part/contracts/index.js';
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
import { initialize, newSession, prompt, withSdk } from '../fixtures/acp.mjs';

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
