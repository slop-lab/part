import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, contextPoint } from '../dist/agent/index.js';
import { functionTool } from '../dist/agent/tools.js';
import { fakeModel } from '../dist/testing/index.js';
import { schema, stringSchema, ok, fail } from '../dist/foundation/contracts.js';
import { createBasicDriver, createValidatingDriver } from '../dist/agent/basic-driver.js';
import { createContextCompiler } from '../dist/context/index.js';
const input = schema('test/text', (v) => v && typeof v === 'object' && typeof v.text === 'string');
const toolSchemas = {
  echo: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};
test('G02: minimal non-coding input -> model -> function tool -> result', async () => {
  let count = 0;
  const model = fakeModel([
    { toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] },
    { text: 'finished' },
  ]);
  const agent = createAgent({
    model,
    tools: [
      functionTool({
        id: 'echo',
        input,
        output: stringSchema,
        execute: ({ text }) => {
          count++;
          return text;
        },
      }),
    ],
    toolSchemas,
  }).value;
  const result = await agent.generate('hello');
  assert.equal(result.ok, true);
  assert.equal(result.value.phase, 'completed');
  assert.equal(result.value.result.content[0].text, 'finished');
  assert.equal(count, 1);
  assert.equal(model.requests.length, 2);
  const second = JSON.parse(new TextDecoder().decode(model.requests[1].body));
  assert.equal(second.messages.at(-1).role, 'tool');
  assert.equal(second.messages.at(-1).content, '"hello"');
  await agent.dispose();
});
test('C02/C08: runtime configuration and model request histories remain isolated', async () => {
  const left = fakeModel([{ text: 'left' }]),
    right = fakeModel([{ text: 'right' }]);
  const a = createAgent({ model: left }).value,
    b = createAgent({ model: right }).value;
  const revision = a.inspectComposition().revision;
  left.profile.model = 'mutated';
  const [l, r] = await Promise.all([a.generate('left input'), b.generate('right input')]);
  assert.equal(l.value.result.content[0].text, 'left');
  assert.equal(r.value.result.content[0].text, 'right');
  assert.equal(JSON.parse(new TextDecoder().decode(left.requests[0].body)).model, 'fixture');
  assert.equal(a.inspectComposition().revision, revision);
  await Promise.all([a.dispose(), b.dispose()]);
});
test('G08/E11: a second driver can reject completion after provider stop', async () => {
  const model = fakeModel([{ text: 'stop is insufficient' }]);
  const driver = createValidatingDriver(
    createBasicDriver({ profileId: 'fake' }),
    stringSchema,
    async () => fail('validator', 'Completion rejected'),
  );
  const agent = createAgent({ model, driver }).value;
  const result = await agent.generate('input');
  assert.equal(result.value.phase, 'failed');
  assert.equal(result.value.error.code, 'part.validator');
  await agent.dispose();
});
test('G06/G07: replacing the middle context service preserves the convenience agent', async () => {
  let calls = 0;
  const original = createContextCompiler().value,
    replacement = {
      compile: async (...args) => {
        calls++;
        return original.compile(...args);
      },
    };
  const agent = createAgent({
    model: fakeModel([{ text: 'ok' }]),
    customize: (spec) => ({
      ...spec,
      edits: [
        (registry) =>
          registry.replace({
            point: { ...contextPoint },
            replaces: 'part/base-context',
            with: { id: 'part/base-context', point: contextPoint, value: replacement },
          }),
      ],
    }),
  }).value;
  assert.equal((await agent.generate('input')).value.phase, 'completed');
  assert.equal(calls, 1);
  await agent.dispose();
});
test('shared invocation/attempt budgets stop the next effect before execution', async () => {
  let count = 0;
  const model = fakeModel([
    { toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] },
    { text: 'never' },
  ]);
  const agent = createAgent({
    model,
    tools: [
      functionTool({
        id: 'echo',
        input,
        output: stringSchema,
        execute: () => {
          count++;
          return 'done';
        },
      }),
    ],
    toolSchemas,
    limits: { maxExecutorAttempts: 1, maxModelInvocations: 5 },
  }).value;
  const result = await agent.generate('input');
  assert.equal(result.value.phase, 'failed');
  assert.equal(count, 0);
  assert.equal(model.requests.length, 1);
  await agent.dispose();
});

test('C07: preset and expanded manual composition execute through the same public parts', async () => {
  const { expandAgent, modelPoint, toolsPoint } = await import('../dist/agent/index.js');
  const { createPlanner, createScopeManager } = await import('../dist/composition/index.js');
  const { createRunService, installDriver } = await import('../dist/runtime/runs.js');
  const { localContext } = await import('../dist/foundation/contracts.js');
  const automatic = createAgent({ model: fakeModel([{ text: 'equivalent' }]) }).value;
  const expanded = expandAgent({ model: fakeModel([{ text: 'equivalent' }]) }).value;
  const composition = createPlanner().resolve(expanded.specification).value;
  const lease = (await createScopeManager().open({ kind: 'runtime', id: 'manual' }, composition))
    .value;
  const services = {
    operations: expanded.operations,
    waits: expanded.waits,
    services: lease.services,
    model: lease.services.get(modelPoint).value,
    tools: lease.services.get(toolsPoint).value,
    context: lease.services.get(contextPoint).value,
  };
  const runService = createRunService({
    drivers: [installDriver(expanded.driver)],
    services,
    operations: expanded.operations,
  }).value;
  const handle = (
    await runService.start(
      { driver: expanded.driver.id, input: 'input', composition },
      localContext({ services: lease.services }),
    )
  ).value;
  assert.equal(
    (await handle.done).result.content[0].text,
    (await automatic.generate('input')).value.result.content[0].text,
  );
  await lease.close();
  await automatic.dispose();
});

test('C09: context-owned registry accepts a new semantic type without replacing the compiler', async () => {
  const { lowerersPoint } = await import('../dist/context/index.js');
  const { emptyCleanup } = await import('../dist/foundation/contracts.js');
  const lowerer = {
    id: 'third-party/lowerer',
    accepts: { id: 'third-party/item', version: 1 },
    lower: (item) =>
      ok({
        kind: 'include',
        fragments: [
          {
            id: item.id,
            kind: 'reference',
            role: 'user',
            content: [{ kind: 'text', text: 'third-party' }],
            sources: [item.source],
            provenance: item.provenance,
          },
        ],
      }),
  };
  const component = {
    descriptor: {
      id: 'third-party',
      version: '1',
      surfaces: ['local'],
      scope: 'runtime',
      requires: [{ id: 'part/context', contractVersion: 1, optional: false }],
      provides: [],
    },
    register: (registry) =>
      registry.contribute({
        id: 'third-party/lowerer',
        point: { ...lowerersPoint },
        key: 'third-party/item@1',
        value: lowerer,
      }),
    create: () =>
      ok({
        initialize: async () => ok(),
        start: async () => ok(),
        stop: async () => emptyCleanup(),
        dispose: async () => emptyCleanup(),
      }),
  };
  const { semanticItem } = await import('../dist/context/index.js');
  const model = fakeModel([{ text: 'extension result' }]);
  const agent = createAgent({ model, components: [component] }).value;
  const result = await agent.generate([
    await semanticItem('third-party/item', { private: 'not emitted' }),
  ]);
  assert.equal(result.value.phase, 'completed');
  assert.equal(
    JSON.parse(new TextDecoder().decode(model.requests[0].body)).messages[0].content,
    'third-party',
  );
  await agent.dispose();
});

test('disposing an agent during admission blocks new driver effects', async () => {
  let calls = 0;
  const { emptyCleanup } = await import('../dist/foundation/contracts.js');
  const driver = {
    id: 'test/dispose-race',
    version: '1',
    input: stringSchema,
    output: stringSchema,
    requires: [],
    create: () => ({
      execute: async () => {
        calls++;
        return {
          phase: 'completed',
          result: 'done',
          effect: 'applied',
          commit: [],
          unsettledChildren: [],
        };
      },
      describeActions: () => [],
      receive: async () => fail('unsupported', 'Unsupported'),
      dispose: async () => emptyCleanup(),
    }),
  };
  const agent = createAgent({ model: fakeModel([]), driver }).value;
  await agent.generate('open');
  calls = 0;
  const pending = agent.start('race');
  const disposed = Promise.resolve().then(() => agent.dispose());
  const admitted = await pending;
  if (admitted.ok) await admitted.value.done;
  await disposed;
  assert.equal(calls, 0);
});
