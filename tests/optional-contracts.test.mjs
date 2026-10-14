import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { localContext, jsonSchema, schema, ok, fail, digest } from '../dist/contracts.js';
import { createMemoryStore } from '../dist/storage-memory.js';
import { createNamespaceMigrations } from '../dist/storage-migrations.js';
import { createCheckpointStore } from '../dist/workflow-checkpoints.js';
import { createNodeScripts } from '../dist/scripts-node.js';
import { createMarkdownView } from '../dist/ui-markdown.js';
import { createRendererRegistry, orderSlots } from '../dist/ui-registry.js';
import { createObservability } from '../dist/observability.js';
import { createHistory } from '../dist/history.js';
import { createChatHistoryAttachment } from '../dist/history-runs.js';
import { createRunService, installDriver } from '../dist/runs.js';
import { createBasicDriver } from '../dist/driver-basic.js';
import { createPlanner } from '../dist/composition.js';
import { createOperations, createBudget, budgetKey } from '../dist/runtime.js';
import { createModelGateway } from '../dist/model.js';
import { fakeModel } from '../dist/testing.js';
import { createContextCompiler, provenance } from '../dist/context.js';
import { createRecipeEngine } from '../dist/workflow-recipe.js';
const context = localContext();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = (result) => ({
  phase: 'completed',
  result,
  effect: 'not-applied',
  commit: [],
  unsettledChildren: [],
});
test('Versioned result channel separates stdout logs/progress and rejects partial or duplicate result frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-channel-'));
  try {
    const source = `const fs=require('fs'); console.log('diagnostic'); fs.writeSync(3,JSON.stringify({protocolVersion:1,channelId:'result',kind:'progress',payload:{step:1}})+'\\n'); fs.writeSync(3,JSON.stringify({protocolVersion:1,channelId:'result',kind:'result',payload:{ok:true}})+'\\n');`;
    const run = async (body) => {
      await writeFile(join(root, 'source.cjs'), body);
      const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } });
      return await (
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
        )
      ).value.done;
    };
    assert.deepEqual((await run(source)).result.captured.value, { ok: true });
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
  const migrated = schema('test/migrated', (value) => value && typeof value.next === 'number');
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
  assert.equal((await store.read(address, context)).value.value.schemaVersion, 1);
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
        transform: (value) => ok({ next: value.old }),
      },
    ],
  });
  assert.equal((await good.migrate([address], context)).ok, true);
  assert.deepEqual((await good.read(address, context)).value.value.value, { next: 1 });
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
  assert.equal(read.value.revision, created.value.revision);
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
  const window = new Window(),
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
    createRendererRegistry([[renderer], [{ ...renderer, id: 'builtin' }]]).value.resolve(
      { type: 'test', schemaVersion: 1 },
      'chat',
    ).value.id,
    'app',
  );
  const slot = (id) => ({ id, slot: 'composer.actions', render: () => null });
  assert.deepEqual(
    orderSlots([{ ...slot('a'), after: ['b'] }, slot('b')]).value.map((s) => s.id),
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
test('Trace metadata strips body/credentials, bounds retention and authorizes manifest access', async () => {
  const policy = {
    mode: 'metadata',
    destinations: ['memory'],
    captureRequestBody: false,
    captureToolOutput: false,
  };
  const trace = createObservability({ policy, maxEvents: 2 });
  const ref = { owner: 'test', kind: 'run', id: 'one' };
  const manifest = {
    execution: ref,
    runtimeVersion: 'test',
    composition: {},
    profileRevisions: {},
    contentDigests: {},
    contextIds: [],
    requestIds: [],
    operationIds: [],
    tracePolicy: policy,
    guarantees: { revision: '1', entries: [] },
  };
  trace.register(manifest, context);
  trace.record(
    ref,
    { type: 'invoke', requestBody: { secret: 'never' }, credentials: 'never' },
    context,
  );
  assert.deepEqual((await trace.readTrace(ref, undefined, context)).value.items, [
    { type: 'invoke' },
  ]);
  trace.record(ref, { type: 'two' }, context);
  trace.record(ref, { type: 'three' }, context);
  trace.record(ref, { type: 'four' }, context);
  assert.equal((await trace.readTrace(ref, '1', context)).ok, false);
  assert.equal(
    (
      await trace.manifest(
        ref,
        localContext({ principal: { subject: 'other', authority: 'test' } }),
      )
    ).ok,
    false,
  );
});
test('Run history attachment appends immutable messages, rejects stale heads and supplies the next compiled request', async () => {
  const history = createHistory();
  const session = (await history.createSession({}, context)).value;
  const model = fakeModel([{ text: 'first response' }, { text: 'second response' }]);
  const operations = createOperations(),
    gateway = createModelGateway({
      profiles: [model.profile],
      adapters: [model.adapter],
      transports: [model.transport],
      auth: { none: model.auth },
      operations,
    }).value;
  const service = createRunService({
    drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
    services: {
      model: gateway,
      context: createContextCompiler().value,
      operations,
      services: context.services,
    },
    operations,
    history: createChatHistoryAttachment(history),
  }).value;
  const composition = createPlanner().resolve({
    components: [
      {
        descriptor: {
          id: 'test/services',
          version: '1',
          surfaces: ['local'],
          scope: 'runtime',
          requires: [],
          provides: ['part/model', 'part/context'].map((id) => ({
            id,
            contractVersion: 1,
            status: 'supported',
            implementedBy: 'test/services',
            constraints: {},
          })),
        },
        register: () => ok(undefined),
        create: () =>
          ok({
            initialize: async () => ok(undefined),
            start: async () => ok(undefined),
            stop: async () => ({ released: [], unresolved: [], errors: [] }),
            dispose: async () => ({ released: [], unresolved: [], errors: [] }),
          }),
      },
    ],
    config: {},
  }).value;
  const request = {
    driver: 'part/basic',
    composition,
    input: 'first input',
    history: { sessionId: session.id, branchId: session.id },
  };
  const first = await service.start(request, context);
  assert.equal(first.ok, true);
  assert.equal((await first.value.done).phase, 'completed');
  assert.equal(
    (
      await service.get(
        first.value.ref,
        localContext({ principal: { subject: 'other', authority: 'test' } }),
      )
    ).ok,
    false,
  );
  assert.equal((await service.start(request, context)).ok, false);
  const branch = (await history.getBranch(session.id, context)).value;
  const second = await service.start(
    {
      ...request,
      input: 'second input',
      history: { ...request.history, expectedHead: branch.head },
    },
    context,
  );
  assert.equal((await second.value.done).phase, 'completed');
  const messages = JSON.parse(new TextDecoder().decode(model.requests[1].body)).messages;
  assert.deepEqual(
    messages.map((m) => m.content),
    ['first input', 'first response', 'second input'],
  );
  assert.equal(
    (await history.path((await history.getBranch(session.id, context)).value, undefined, context))
      .value.items.length,
    4,
  );
});
test('Recipe retries explicit read-only validation, but never retries failed or uncertain effects', async () => {
  let calls = 0;
  const output = schema('test/answer', (value) => value?.answer === 42);
  const definition = {
    id: 'recipe',
    format: 'part.recipe',
    version: 1,
    input: jsonSchema.ref,
    output: output.ref,
    agentProfile: 'local',
    maxAttempts: 2,
    retry: 'read-only-validation',
  };
  const composition = { inspection: { revision: '1' } };
  const operations = createOperations();
  const engine = createRecipeEngine({
    definitions: [definition],
    schemas: [jsonSchema, output],
    agents: { local: { driver: 'test', composition, effects: 'read' } },
    services: {
      operations,
      runs: {
        start: (_request, c) =>
          operations.begin(
            { kind: 'part/run', childPolicy: 'attached', retryOwner: 'test' },
            async () => outcome({ answer: ++calls === 1 ? 0 : 42 }),
            c,
          ),
      },
    },
  }).value;
  const prepared = (
    await engine.prepare(
      {
        engineId: engine.descriptor.id,
        definition: {
          id: definition.id,
          format: definition.format,
          formatVersion: '1',
          digest: await digest(definition),
          source: { owner: 'test', native: {} },
        },
        profileId: 'default',
        requiredCapabilities: [],
        requiredControl: 'runner-enforced',
      },
      context,
    )
  ).value;
  const started = await engine.start({ requestId: 'one', prepared, input: {} }, context);
  for (
    let i = 0;
    i < 200 && (await engine.get(started.ref, context)).value.phase === 'running';
    i++
  )
    await delay(2);
  assert.equal((await engine.get(started.ref, context)).value.phase, 'succeeded');
  assert.equal(calls, 2);
});

test('Estimated cost ceilings reserve before transport, require explicit pricing and preserve actual effect evidence', async () => {
  const { createAgent } = await import('../dist/agent.js');
  const { functionTool } = await import('../dist/tools.js');
  const { costUnits } = await import('../dist/costs.js');
  assert.equal(costUnits('0.000001').value, 1);
  assert.equal(costUnits('0.0000001').ok, false);
  assert.equal(costUnits('-1').ok, false);
  let writes = 0;
  const model = fakeModel([
    { toolCalls: [{ name: 'write', arguments: {} }] },
    { text: 'must not send' },
  ]);
  const agent = createAgent({
    model,
    tools: [
      functionTool({
        id: 'write',
        input: jsonSchema,
        output: jsonSchema,
        execute: () => {
          writes++;
          return null;
        },
      }),
    ],
    toolSchemas: { write: {} },
    limits: { estimatedCostCeiling: { amount: '0.25', currency: 'USD' } },
    costEstimator: {
      id: 'test/pricing',
      version: '1',
      estimate: async () => ok({ amount: '0.15', currency: 'USD' }),
    },
  }).value;
  const result = await agent.generate('input');
  assert.equal(result.value.phase, 'failed');
  assert.equal(model.requests.length, 1);
  assert.equal(writes, 1);
  assert.equal(result.value.effect, 'applied');
  await agent.dispose();
  const unpriced = fakeModel([{ text: 'must not send' }]);
  const denied = createAgent({
    model: unpriced,
    limits: { estimatedCostCeiling: { amount: '1', currency: 'USD' } },
  }).value;
  assert.equal((await denied.generate('input')).value.phase, 'failed');
  assert.equal(unpriced.requests.length, 0);
  await denied.dispose();
});

test('DOM components, ordered slots, inspector and artifact viewers use only public client contracts', async () => {
  const { createWatchHub, createLocalPort, createController } = await import('../dist/client.js');
  const { createChat } = await import('../dist/ui-dom.js');
  const { createInspector } = await import('../dist/ui-inspector.js');
  const hub = createWatchHub({ revision: '1', entries: [] });
  const endpoint = {
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
  const window = new Window();
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
  inspector.element.querySelector('button').click();
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
    const request = {
      requestId: 'one',
      executorId: 'part/node-process',
      source: { packageId: 'installed', relativePath: 'script.cjs', digest: await digest(source) },
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
    const outcome = await (await scripts.execute(request, context)).value.done;
    assert.equal(outcome.phase, 'completed');
    assert.equal(outcome.result.captured.value.cwd, root);
    assert.equal(
      (
        await scripts.execute(
          { ...request, workspace: { ...request.workspace, id: 'denied' } },
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
    assert.equal((await scripts.execute(null, context)).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
