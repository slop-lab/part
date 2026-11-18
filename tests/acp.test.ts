import { methods } from '@agentclientprotocol/sdk';
import { createAcpAgent } from '@slop-lab/part-plugins/acp/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { ok } from '@slop-lab/part/contracts/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { deferred, expectProperty, present } from '../fixtures/assertions.mjs';
import { initialize, newSession, prompt, toolOptions, withSdk } from '../fixtures/acp.mjs';
import type { AcpSessionSetup } from '@slop-lab/part-plugins/acp/index.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

test('Official ACP SDK initializes, receives text and embedded context, and preserves isolated session histories', async () => {
  const models: ReturnType<typeof fakeModel>[] = [],
    setups: AcpSessionSetup[] = [];
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
      const history: { content: string }[] = JSON.parse(
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
    const executions: string[] = [];
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
  const executions: string[] = [],
    asked = deferred<RequestPermissionRequest>(),
    decision = deferred<RequestPermissionResponse>();
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
  for (const permissions of ['writes', 'all'] as const) {
    const executions: string[] = [];
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
  const models: ReturnType<typeof fakeModel>[] = [];
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
    const executions: string[] = [],
      asked = deferred(),
      decision = deferred<RequestPermissionResponse>();
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
  const configured = deferred<AcpSessionSetup>(),
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

test('ACP session close cancels outstanding permission work and releases session capacity', async () => {
  const executions: string[] = [],
    asked = deferred(),
    permission = deferred<RequestPermissionResponse>();
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

test('Official SDK request cancellation cancels the permission UI without accepting a late decision', async () => {
  const asked = deferred(),
    dismissed = deferred(),
    executions: string[] = [];
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
  const executions: string[] = [];
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
            createDecoder(response: Parameters<typeof original.createDecoder>[0]) {
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
