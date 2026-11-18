// @ts-check
import { createBasicDriver } from '@slop-lab/part-plugins/agent/drivers/basic.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { createRecipeEngine } from '@slop-lab/part-plugins/workflows/recipe.js';
import { createPlanner } from '@slop-lab/part/composition/index.js';
import { createHistory } from '@slop-lab/part/context/history.js';
import { createContextCompiler } from '@slop-lab/part/context/index.js';
import { createChatHistoryAttachment } from '@slop-lab/part/context/run-history.js';
import { digest, jsonSchema, localContext, ok, schema } from '@slop-lab/part/contracts/index.js';
import { createModelGateway } from '@slop-lab/part/model/index.js';
import { createOperations } from '@slop-lab/part/runtime/index.js';
import { createObservability } from '@slop-lab/part/runtime/observability.js';
import { createRunService, installDriver } from '@slop-lab/part/runtime/runs.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, json, present, stub } from '../fixtures/assertions.mjs';
const context = localContext();
const delay = /** @param {number} ms */ (ms) => new Promise((r) => setTimeout(r, ms));
/** @template T @param {T} result @returns {import("@slop-lab/part/reference/index.js").Runtime.ManagedOutcome<T>} */
const outcome = (result) => ({
  phase: /** @type {const} */ ('completed'),
  result,
  effect: /** @type {const} */ ('not-applied'),
  commit: [],
  unsettledChildren: [],
});

test('Trace metadata strips body/credentials, bounds retention and authorizes manifest access', async () => {
  /** @type {import('@slop-lab/part/reference/index.js').Observability.TracePolicy} */
  const policy = {
    mode: 'metadata',
    destinations: ['memory'],
    captureRequestBody: false,
    captureToolOutput: false,
  };
  const trace = createObservability({ policy, maxEvents: 2 });
  const ref = { owner: 'test', kind: 'run', id: 'one' };
  /** @type {import('@slop-lab/part/reference/index.js').Observability.InvocationManifest} */
  const manifest = {
    execution: ref,
    runtimeVersion: 'test',
    composition: stub({}),
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
  assert.deepEqual(expectProperty(await trace.readTrace(ref, undefined, context), 'value').items, [
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
  const session = expectProperty(await history.createSession({}, context), 'value');
  const model = fakeModel([{ text: 'first response' }, { text: 'second response' }]);
  const operations = createOperations(),
    gateway = expectProperty(
      createModelGateway({
        profiles: [model.profile],
        adapters: [model.adapter],
        transports: [model.transport],
        auth: { none: model.auth },
        operations,
      }),
      'value',
    );
  const service = expectProperty(
    createRunService({
      drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
      services: {
        model: gateway,
        context: expectProperty(createContextCompiler(), 'value'),
        operations,
        services: context.services,
      },
      operations,
      history: createChatHistoryAttachment(history),
    }),
    'value',
  );
  const composition = expectProperty(
    createPlanner().resolve({
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
    }),
    'value',
  );
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
  const branch = expectProperty(await history.getBranch(session.id, context), 'value');
  const second = await service.start(
    {
      ...request,
      input: 'second input',
      history: { ...request.history, expectedHead: branch.head },
    },
    context,
  );
  assert.equal((await expectProperty(second, 'value').done).phase, 'completed');
  /** @type {{content: string}[]} */
  const messages = JSON.parse(new TextDecoder().decode(present(model.requests[1]).body)).messages;
  assert.deepEqual(
    messages.map((m) => m.content),
    ['first input', 'first response', 'second input'],
  );
  assert.equal(
    expectProperty(
      await history.path(
        expectProperty(await history.getBranch(session.id, context), 'value'),
        undefined,
        context,
      ),
      'value',
    ).items.length,
    4,
  );
});
test('Recipe retries explicit read-only validation, but never retries failed or uncertain effects', async () => {
  let calls = 0;
  const output = schema(
    'test/answer',
    /** @param {unknown} value @returns {value is {answer: 42}} */ (value) =>
      value !== null && typeof value === 'object' && 'answer' in value && value.answer === 42,
  );
  /** @type {import('@slop-lab/part-plugins/workflows/recipe.js').RecipeDefinition} */
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
  const composition = expectProperty(
    createPlanner().resolve({ components: [], config: {} }),
    'value',
  );
  const operations = createOperations();
  const engine = expectProperty(
    createRecipeEngine({
      definitions: [definition],
      schemas: [jsonSchema, output],
      agents: { local: { driver: 'test', composition, effects: 'read' } },
      services: {
        operations,
        runs: stub({
          /** @param {import("@slop-lab/part/reference/index.js").Runtime.RunRequest<unknown>} _request @param {import("@slop-lab/part/reference/index.js").Contracts.InvocationContext} c */
          start: (_request, c) =>
            operations.begin(
              { kind: 'part/run', childPolicy: 'attached', retryOwner: 'test' },
              async () => outcome({ answer: ++calls === 1 ? 0 : 42 }),
              c,
            ),
        }),
      },
    }),
    'value',
  );
  const prepared = expectProperty(
    await engine.prepare(
      {
        engineId: engine.descriptor.id,
        definition: {
          id: expectProperty(definition, 'id'),
          format: expectProperty(definition, 'format'),
          formatVersion: '1',
          digest: await digest(json(definition)),
          source: { owner: 'test', native: {} },
        },
        profileId: 'default',
        requiredCapabilities: [],
        requiredControl: 'runner-enforced',
      },
      context,
    ),
    'value',
  );
  const started = await engine.start({ requestId: 'one', prepared, input: {} }, context);
  for (
    let i = 0;
    i < 200 &&
    expectProperty(await engine.get(expectProperty(started, 'ref'), context), 'value').phase ===
      'running';
    i++
  )
    await delay(2);
  assert.equal(
    expectProperty(await engine.get(expectProperty(started, 'ref'), context), 'value').phase,
    'succeeded',
  );
  assert.equal(calls, 2);
});

test('Estimated cost ceilings reserve before transport, require explicit pricing and preserve actual effect evidence', async () => {
  const { createAgent } = await import('@slop-lab/part-plugins/agent/index.js');
  const { functionTool } = await import('@slop-lab/part/tools.js');
  const { costUnits } = await import('@slop-lab/part/runtime/costs.js');
  assert.equal(expectProperty(costUnits('0.000001'), 'value'), 1);
  assert.equal(costUnits('0.0000001').ok, false);
  assert.equal(costUnits('-1').ok, false);
  let writes = 0;
  const model = fakeModel([
    { toolCalls: [{ name: 'write', arguments: {} }] },
    { text: 'must not send' },
  ]);
  const agent = expectProperty(
    createAgent({
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
    }),
    'value',
  );
  const result = await agent.generate('input');
  assert.equal(expectProperty(result, 'value').phase, 'failed');
  assert.equal(model.requests.length, 1);
  assert.equal(writes, 1);
  assert.equal(expectProperty(result, 'value').effect, 'applied');
  await agent.dispose();
  const unpriced = fakeModel([{ text: 'must not send' }]);
  const denied = expectProperty(
    createAgent({
      model: unpriced,
      limits: { estimatedCostCeiling: { amount: '1', currency: 'USD' } },
    }),
    'value',
  );
  assert.equal(expectProperty(await denied.generate('input'), 'value').phase, 'failed');
  assert.equal(unpriced.requests.length, 0);
  await denied.dispose();
});
