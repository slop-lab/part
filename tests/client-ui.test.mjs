// @ts-check
import { expectProperty, json, stub } from '../fixtures/assertions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { createAgent } from '@slop-lab/part-plugins/agent';
import { fakeModel } from '@slop-lab/part-plugins/testing';
import { createEmbeddedEndpoint } from '@slop-lab/part/host/embedded';
import {
  createLocalPort,
  createWatchHub,
  createController,
  jsonCodec,
} from '@slop-lab/part/client';
import { createComposer } from '@slop-lab/part-browser/headless';
import { createChat } from '@slop-lab/part-browser/dom';
import { localContext } from '@slop-lab/part/contracts';
const context = localContext();
const command = (text, id = crypto.randomUUID()) => ({
  protocolVersion: 1,
  commandId: id,
  actionId: 'part.run/start',
  actionVersion: 1,
  input: text,
  idempotencyKey: id,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('G09/G10: in-process and codec loopback have command/query/watch parity', async () => {
  for (const codecLoopback of [false, true]) {
    const model = fakeModel([{ text: 'reply' }]),
      agent = expectProperty(createAgent({ model }), 'value'),
      endpoint = expectProperty(createEmbeddedEndpoint(agent, { context }), 'value');
    const port = createLocalPort(endpoint, () => context, { codecLoopback }),
      controller = createController(port);
    assert.equal((await port.discover()).ok, true);
    assert.equal((await controller.connect({ surface: 'chat' })).ok, true);
    const request = command('hello');
    const delivery = await port.command(request);
    assert.equal(expectProperty(delivery, 'receipt').kind, 'accepted');
    const duplicate = await port.command(request);
    assert.deepEqual(expectProperty(duplicate, 'receipt'), expectProperty(delivery, 'receipt'));
    await delay(10);
    assert.equal(model.requests.length, 1);
    assert.equal(controller.getState().itemIds.length, 2);
    const snapshot = await port.query({
      queryId: 'part.run/get',
      version: 1,
      input: expectProperty(expectProperty(delivery, 'receipt'), 'operation').id,
    });
    assert.equal(expectProperty(expectProperty(snapshot, 'value'), 'phase'), 'completed');
    const latest = controller.getItem(
      `${expectProperty(expectProperty(delivery, 'receipt'), 'operation').id}/assistant`,
    );
    assert.equal(latest.fallback.text, 'reply');
    assert.equal(
      expectProperty(await port.command({ ...request, input: 'changed' }), 'receipt').kind,
      'rejected',
    );
    assert.equal(
      // @ts-expect-error Unknown actor fields must be rejected at the wire boundary.
      expectProperty(await port.command({ ...command('bad'), actor: 'admin' }), 'receipt').kind,
      'rejected',
    );
    await controller.dispose();
    await endpoint.close();
  }
});
test('DU05/DU06/DU08: snapshot subscription includes intervening updates and authorization reset clears cache', async () => {
  const hub = createWatchHub({ revision: '1', entries: [] }),
    controller = createController(stub({ watch: () => hub.watch(context) }));
  await controller.connect({ surface: 'chat' });
  const item = {
    id: 'private',
    type: 'custom',
    schemaVersion: 1,
    revision: '1',
    payload: { text: 'permitted' },
    fallback: { label: 'Safe' },
    actions: [],
    artifacts: [],
  };
  hub.upsert(item);
  hub.delta({ itemId: 'private', partId: 'text', generation: 'g', offset: 0, text: '안녕' });
  await delay(0);
  assert.equal(controller.getItem('private').fallback.label, 'Safe');
  assert.equal(controller.getPart('private', 'text').offset, 2);
  assert.equal(
    hub.delta({ itemId: 'private', partId: 'text', generation: 'g', offset: 0, text: 'duplicate' })
      .ok,
    false,
  );
  hub.reset([], 'reduced');
  await delay(0);
  assert.equal(controller.getItem('private'), undefined);
  assert.equal(controller.getPart('private', 'text'), undefined);
  await controller.dispose();
  hub.close();
});
test('DU07: not-sent and delivery-unknown are distinct; disconnect does not cancel runs', async () => {
  let count = 0;
  /** @type {import('@slop-lab/part/reference').Client.Endpoint} */
  const endpoint = stub({
    command: async () => {
      count++;
      throw Error('receipt lost');
    },
  });
  const port = createLocalPort(endpoint, () => context, { codecLoopback: true });
  const abort = new AbortController();
  abort.abort();
  assert.equal((await port.command(command('x'), { signal: abort.signal })).kind, 'not-sent');
  assert.equal(count, 0);
  const unknown = await port.command(command('x'));
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.recovery, 'same-key-retry');
  assert.equal(count, 1);
  assert.equal(
    (await port.command({ ...command('x'), input: /** @type {any} */ (() => {}) })).kind,
    'not-sent',
  );
  assert.equal(count, 1);
});
test('DU09: composing Enter cannot submit and late success preserves a new draft', async () => {
  let count = 0,
    /** @type {(...args: any[]) => void} */ release;
  const composer = createComposer({
    command: (draft) => command(draft.text),
    invoke: async (request) => {
      count++;
      await new Promise((r) => {
        release = r;
      });
      return {
        kind: 'receipt',
        receipt: {
          kind: 'accepted',
          commandId: request.commandId,
          operation: { owner: 'test', kind: 'run', id: 'r' },
          commit: [],
        },
      };
    },
  });
  composer.setDraft({ text: '한', references: [], revision: 1 });
  composer.setComposing(true);
  assert.equal((await composer.submit('enter')).kind, 'not-sent');
  assert.equal(count, 0);
  composer.setComposing(false);
  const pending = composer.submit('button');
  composer.setDraft({ text: 'new', references: [], revision: 2 });
  release();
  await pending;
  assert.equal(composer.getDraft().text, 'new');
});
test('G10/X05/X06: DOM Chat supports custom cards, safe fallback, IME, CSS and cleanup', async () => {
  const window =
      /** @type {globalThis.Window & typeof globalThis & { happyDOM: import('happy-dom').Window['happyDOM'] }} */ (
        /** @type {unknown} */ (new Window())
      ),
    document = window.document;
  const hub = createWatchHub({ revision: '1', entries: [] }),
    controller = createController(
      stub({
        watch: () => hub.watch(context),
        command: async (request) => ({
          kind: 'receipt',
          receipt: {
            kind: 'completed',
            commandId: request.commandId,
            result: null,
            effect: 'not-applied',
            commit: [],
          },
        }),
      }),
    );
  await controller.connect({ surface: 'chat' });
  const card = {
    id: 'card',
    type: 'test/card',
    schemaVersion: 1,
    revision: '1',
    payload: { summary: 'custom' },
    fallback: { label: 'Safe fallback' },
    actions: [],
    artifacts: [],
  };
  hub.upsert(card);
  await delay(0);
  const chat = createChat({
    client: controller,
    document,
    command: (draft) => command(draft.text),
    className: 'custom-theme',
    theme: { radius: '2rem' },
    renderers: [
      {
        id: 'card',
        type: 'test/card',
        schemaVersions: [1],
        target: 'chat',
        render: (item) => {
          const node = document.createElement('p');
          node.textContent = expectProperty(item.payload, 'summary');
          return node;
        },
      },
    ],
  });
  document.body.append(chat.element);
  assert.equal(chat.element.textContent.includes('custom'), true);
  assert.equal(chat.element.style.getPropertyValue('--part-radius'), '2rem');
  const fallback = createChat({
    client: controller,
    document,
    command: (draft) => command(draft.text),
  });
  assert.equal(fallback.element.textContent.includes('Safe fallback'), true);
  const textarea = chat.element.querySelector('textarea');
  textarea.value = '한';
  textarea.dispatchEvent(new window.Event('input'));
  textarea.dispatchEvent(new window.Event('compositionstart'));
  textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(chat.composer.getDraft().text, '한');
  await chat.dispose();
  await fallback.dispose();
  assert.equal(controller.getState().connection, 'connected');
  await controller.dispose();
  hub.close();
  window.happyDOM.cancelAsync();
});
test('C01/C10: browser entrypoint excludes storage, executor, provider and credential implementations', async () => {
  const result = await build({
    stdin: {
      contents:
        "export { createChat } from '@slop-lab/part-browser/dom'; export { createController } from '@slop-lab/part/client';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  const paths = Object.keys(result.metafile.inputs);
  for (const excluded of [
    'packages/node/',
    'packages/plugins/',
    '/tools.js',
    '/model/index.js',
    '/host/embedded.js',
  ])
    assert.equal(
      paths.some((p) => p.includes(excluded)),
      false,
    );
  assert.equal(result.outputFiles[0].text.includes('node:sqlite'), false);
});

test('G10: themed Chat sends to the real embedded agent, streams text and cancels through the owner action', async () => {
  const window =
      /** @type {globalThis.Window & typeof globalThis & { happyDOM: import('happy-dom').Window['happyDOM'] }} */ (
        /** @type {unknown} */ (new Window())
      ),
    model = fakeModel([{ text: 'streamed response' }]);
  const transport = model.transport;
  // @ts-expect-error Deliberately attempt mutation to verify snapshot isolation.
  model.transport = {
    ...transport,
    async send(...args) {
      const result = await transport.send(args[0], args[1], args[2], args[3]);
      if (result.ok === false) return result;
      const body = result.value.body;
      return {
        ...result,
        value: {
          ...result.value,
          body: (async function* () {
            for await (const chunk of body) {
              await delay(5);
              yield chunk;
            }
          })(),
        },
      };
    },
  };
  const agent = expectProperty(createAgent({ model }), 'value'),
    endpoint = expectProperty(createEmbeddedEndpoint(agent, { context }), 'value'),
    controller = createController(
      createLocalPort(endpoint, () => context, { codecLoopback: true }),
    );
  await controller.connect({ surface: 'chat' });
  const chat = createChat({
    client: controller,
    document: window.document,
    command: (draft) => command(draft.text),
  });
  window.document.body.append(chat.element);
  try {
    const textarea = chat.element.querySelector('textarea');
    textarea.value = 'stream please';
    textarea.dispatchEvent(new window.Event('input'));
    await chat.composer.submit('api');
    for (let i = 0; i < 100 && !chat.element.querySelector('article button'); i++) await delay(2);
    const cancel = chat.element.querySelector('article button');
    assert.equal(cancel.textContent, 'part.run/cancel');
    await delay(15);
    /** @type {HTMLElement} */ (cancel).click();
    for (let i = 0; i < 100 && !chat.element.textContent.includes('Cancelled'); i++) await delay(2);
    assert.equal(chat.element.textContent.includes('Cancelled'), true);
    assert.equal(model.requests.length, 1);
  } finally {
    await chat.dispose();
    await controller.dispose();
    await endpoint.close();
    window.happyDOM.cancelAsync();
  }
});
