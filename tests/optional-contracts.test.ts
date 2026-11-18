import { createMarkdownView } from '@slop-lab/part-browser/markdown.js';
import { createRendererRegistry, orderSlots } from '@slop-lab/part-browser/registry.js';
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createCheckpointStore } from '@slop-lab/part-plugins/workflows/checkpoints.js';
import {
  digest,
  fail,
  jsonSchema,
  localContext,
  ok,
  schema,
} from '@slop-lab/part/contracts/index.js';
import { createMemoryStore } from '@slop-lab/part/storage/memory.js';
import { createNamespaceMigrations } from '@slop-lab/part/storage/migrations.js';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty, present, stub } from '../fixtures/assertions.mjs';
import type { Client, Scripts } from '@slop-lab/part/reference/index.js';
const context = localContext();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Versioned result channel separates stdout logs/progress and rejects partial or duplicate result frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-channel-'));
  try {
    const source = `const fs=require('fs'); console.log('diagnostic'); fs.writeSync(3,JSON.stringify({protocolVersion:1,channelId:'result',kind:'progress',payload:{step:1}})+'\\n'); fs.writeSync(3,JSON.stringify({protocolVersion:1,channelId:'result',kind:'result',payload:{ok:true}})+'\\n');`;
    const run = async (body: string) => {
      await writeFile(join(root, 'source.cjs'), body);
      const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } });
      return await expectProperty(
        await scripts.execute(
          {
            requestId: crypto.randomUUID(),
            executorId: 'part/node-process',
            source: {
              relativePath: 'source.cjs',
              digest: await digest(new TextEncoder().encode(body)),
            },
            interpreter: 'node',
            args: [],
            effects: 'read',
            retry: 'never',
            capture: { kind: 'channel', channelId: 'result', protocolVersion: 1, maxBytes: 1024 },
          },
          context,
        ),
        'value',
      ).done;
    };
    assert.deepEqual(
      expectProperty(expectProperty(await run(source), 'result').captured, 'value'),
      { ok: true },
    );
    assert.equal(
      (
        await run(
          source +
            `require('fs').writeSync(3,JSON.stringify({protocolVersion:1,channelId:'result',kind:'result',payload:null})+'\\n');`,
        )
      ).phase,
      'failed',
    );
    assert.equal((await run(`require('fs').writeSync(3,'{"kind":"result"}');`)).phase, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Namespace migration publishes atomically and failed transformations leave old bytes unreadable as the new schema', async () => {
  const store = createMemoryStore();
  const address = { namespace: 'test/data', scope: { kind: 'runtime', id: 'test' }, key: 'one' };
  await store.commit(
    {
      id: 'initial',
      mutations: [{ address, expected: 'absent', next: { schemaVersion: 1, value: { old: 1 } } }],
      append: [],
    },
    context,
  );
  const migrated = schema(
    'test/migrated',
    (value: unknown): value is { next: number } =>
      value !== null &&
      typeof value === 'object' &&
      'next' in value &&
      typeof value.next === 'number',
  );
  const bad = createNamespaceMigrations(store, {
    namespace: address.namespace,
    owner: 'test',
    targetVersion: 2,
    schema: migrated,
    migrations: [
      {
        namespace: address.namespace,
        from: 1,
        to: 2,
        transform: () => fail('test.transform', 'Invalid migration'),
      },
    ],
  });
  assert.equal((await bad.read(address, context)).ok, false);
  assert.equal((await bad.migrate([address], context)).ok, false);
  assert.equal(
    present(expectProperty(await store.read(address, context), 'value')).value.schemaVersion,
    1,
  );
  const good = createNamespaceMigrations(store, {
    namespace: address.namespace,
    owner: 'test',
    targetVersion: 2,
    schema: migrated,
    migrations: [
      {
        namespace: address.namespace,
        from: 1,
        to: 2,
        transform: (value) => ok({ next: expectProperty(value, 'old') }),
      },
    ],
  });
  assert.equal((await good.migrate([address], context)).ok, true);
  assert.deepEqual(
    present(expectProperty(await good.read(address, context), 'value')).value.value,
    {
      next: 1,
    },
  );
});
test('Checkpoint storage binds engine/definition, enforces CAS and keeps native scheduling with its owner', async () => {
  const checkpoints = createCheckpointStore(createMemoryStore());
  const ref = { engine: 'test/engine', engineVersion: '1', id: 'one' };
  const checkpoint = {
    execution: ref,
    definitionDigest: 'definition',
    engineVersion: '1',
    revision: 'uncommitted',
    stateSchema: jsonSchema.ref,
    state: { next: 2 },
    completedCalls: [],
    pendingEffects: [],
  };
  const created = await checkpoints.commit('absent', checkpoint, context);
  assert.equal(created.ok, true);
  const read = await checkpoints.read(ref, context);
  assert.equal(present(expectProperty(read, 'value')).revision, created.value.revision);
  assert.equal((await checkpoints.commit('absent', checkpoint, context)).ok, false);
  assert.equal(
    (
      await checkpoints.read(
        ref,
        localContext({ principal: { subject: 'other', authority: 'test' } }),
      )
    ).ok,
    false,
  );
});
test('Safe Markdown caches completed blocks and renderer/slot registries enforce explicit priorities/order', () => {
  const window = new Window() as unknown as globalThis.Window &
      typeof globalThis & { happyDOM: import('happy-dom').Window['happyDOM'] },
    view = createMarkdownView(window.document);
  view.update('**Completed**\n\npartial');
  const first = view.element.firstChild;
  view.update('**Completed**\n\npartial grows');
  assert.equal(view.element.firstChild, first);
  view.update('<script>bad()</script>\n\n[unsafe](javascript:alert)\n\n```js\nconst x=1;\n```');
  assert.equal(view.element.querySelector('script'), null);
  assert.equal(view.element.querySelector('a'), null);
  assert.ok(view.element.querySelector('pre code'));
  const renderer = {
    id: 'app',
    target: 'chat',
    type: 'test',
    schemaVersions: [1],
    render: () => null,
  };
  assert.equal(createRendererRegistry([[renderer, renderer]]).ok, false);
  assert.equal(
    expectProperty(
      expectProperty(
        createRendererRegistry([[renderer], [{ ...renderer, id: 'builtin' }]]),
        'value',
      ).resolve(stub({ type: 'test', schemaVersion: 1 }), 'chat'),
      'value',
    ).id,
    'app',
  );
  const slot = (id: string) => ({ id, slot: 'composer.actions', render: () => null });
  assert.deepEqual(
    expectProperty(orderSlots([{ ...slot('a'), after: ['b'] }, slot('b')]), 'value').map(
      (s) => s.id,
    ),
    ['b', 'a'],
  );
  assert.equal(
    orderSlots([
      { ...slot('a'), after: ['b'] },
      { ...slot('b'), after: ['a'] },
    ]).ok,
    false,
  );
  window.happyDOM.cancelAsync();
});

test('DOM components, ordered slots, inspector and artifact viewers use only public client contracts', async () => {
  const { createWatchHub, createLocalPort, createController } =
    await import('@slop-lab/part/client/index.js');
  const { createChat } = await import('@slop-lab/part-browser/dom.js');
  const { createInspector } = await import('@slop-lab/part-browser/inspector.js');
  const hub = createWatchHub({ revision: '1', entries: [] });
  const endpoint: Client.Endpoint = {
    watch: (_request, c) => hub.watch(c),
    query: async () => ok(null),
    command: async (request) => ({
      kind: 'completed',
      commandId: request.commandId,
      result: null,
      effect: 'not-applicable',
      commit: [],
    }),
  };
  const controller = createController(createLocalPort(endpoint, () => context));
  const window = new Window() as unknown as globalThis.Window &
    typeof globalThis & { happyDOM: import('happy-dom').Window['happyDOM'] };
  await controller.connect({ surface: 'chat' });
  let custom = 0,
    reads = 0;
  const chat = createChat({
    client: controller,
    document: window.document,
    command: () => ({
      protocolVersion: 1,
      commandId: 'one',
      actionId: 'test',
      actionVersion: 1,
      input: null,
    }),
    components: {
      Message(_item, _context, body) {
        custom++;
        const element = window.document.createElement('article');
        element.append(body);
        return element;
      },
    },
    slots: [
      {
        id: 'last',
        slot: 'message.actions',
        after: ['first'],
        render: () => {
          const node = window.document.createElement('span');
          node.textContent = 'last';
          return node;
        },
      },
      {
        id: 'first',
        slot: 'message.actions',
        render: () => {
          const node = window.document.createElement('span');
          node.textContent = 'first';
          return node;
        },
      },
    ],
  });
  const inspector = createInspector({
    client: controller,
    document: window.document,
    artifacts: {
      async read() {
        reads++;
        return ok({
          bytes: new TextEncoder().encode('<script>not executable</script>'),
          mediaType: 'text/plain',
        });
      },
    },
  });
  hub.upsert({
    id: 'one',
    type: 'test/unknown',
    schemaVersion: 1,
    revision: '1',
    payload: { public: true },
    fallback: { label: 'Public item', text: 'Safe text' },
    actions: [],
    artifacts: [{ store: 'test', id: 'artifact' }],
  });
  await delay(5);
  assert.equal(custom, 1);
  assert.ok(chat.element.textContent.indexOf('first') < chat.element.textContent.indexOf('last'));
  assert.equal(reads, 0);
  present(inspector.element.querySelector('button')).click();
  await delay(1);
  assert.equal(reads, 1);
  assert.equal(inspector.element.querySelector('script'), null);
  assert.ok(inspector.element.textContent.includes('not executable'));
  await chat.dispose();
  await inspector.dispose();
  await controller.dispose();
  hub.close();
  window.happyDOM.cancelAsync();
});

test('Script source/workspace resolvers pin packaged bytes and capture only declared workspace JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-resolved-script-'));
  try {
    const source = new TextEncoder().encode(
      'require("fs").writeFileSync("output.json",JSON.stringify({cwd:process.cwd()}));',
    );
    const scripts = createNodeScripts({
      root,
      interpreters: { node: process.execPath },
      source: async () => ok(source),
      workspace: async (ref) =>
        ref.id === 'allowed' ? ok(root) : fail('test.workspace', 'Workspace denied', 'permission'),
    });
    const request: Scripts.Request = {
      requestId: 'one',
      executorId: 'part/node-process',
      source: {
        packageId: 'installed',
        relativePath: 'script.cjs',
        digest: await digest(source),
      },
      interpreter: 'node',
      args: [],
      workspace: { owner: 'test', kind: 'workspace', id: 'allowed' },
      capture: {
        kind: 'file',
        relativePath: 'output.json',
        mediaType: 'application/json',
        maxBytes: 1024,
      },
      effects: 'write',
      retry: 'never',
    };
    const outcome = await expectProperty(await scripts.execute(request, context), 'value').done;
    assert.equal(outcome.phase, 'completed');
    assert.equal(
      expectProperty(expectProperty(outcome.result.captured, 'value'), 'cwd'),
      await realpath(root),
    );
    assert.equal(
      (
        await scripts.execute(
          { ...request, workspace: { ...present(request.workspace), id: 'denied' } },
          context,
        )
      ).ok,
      false,
    );
    assert.equal(
      (
        await scripts.execute(
          { ...request, source: { ...request.source, digest: '0'.repeat(64) } },
          context,
        )
      ).ok,
      false,
    );
    // @ts-expect-error Deliberately invalid request must fail runtime validation.
    assert.equal((await scripts.execute(null, context)).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
