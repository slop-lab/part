import { createCarAgent } from '../car/src/agent.mjs';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { subagentToolId } from '@slop-lab/part-plugins/swe/subagents.js';
import { fail, ok, schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { budgetKey, createBudget } from '@slop-lab/part/runtime/budget.js';
import { functionTool } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, stub } from '../fixtures/assertions.mjs';
import type { Contracts, Convenience, Model, Runtime } from '@slop-lab/part/reference/index.js';

test('Car preserves Model.Response while rejecting an unvalidated coding completion', async () => {
  // Given: the provider claims completion but the workspace validator rejects it.
  const created = createCarAgent({
    model: fakeModel([{ text: 'done' }]),
    validate: async () => fail('car.incomplete', 'Tests are failing'),
  });
  const agent = expectProperty(created, 'value');

  // When: the root coding run stops.
  const outcome = expectProperty(await agent.generate('fix it'), 'value');

  // Then: completion fails with the validator error instead of trusting prose.
  assert.equal(outcome.phase, 'failed');
  assert.equal(expectProperty(expectProperty(outcome, 'error'), 'code'), 'part.car.incomplete');
  await agent.dispose();
});

test('Car executes a subagent through inherited runtime services and returns to the root', async () => {
  // Given: the root delegates once and the child completes on the shared model service.
  const model = fakeModel([
    { toolCalls: [{ name: subagentToolId, arguments: { task: 'inspect', context: 'facts' } }] },
    { text: 'child result' },
    { text: 'root result' },
  ]);
  const agent = expectProperty(createCarAgent({ model }), 'value');

  // When: the root coding run invokes its managed subagent tool.
  const outcome = expectProperty(await agent.generate('delegate'), 'value');

  // Then: child and root finish through one model/runtime graph.
  assert.equal(outcome.phase, 'completed');
  assert.equal(expectProperty(expectProperty(outcome, 'result').content[0], 'text'), 'root result');
  assert.equal(model.requests.length, 3);
  await agent.dispose();
});

test('Car child execution shares the root maxChildRuns budget', async () => {
  // Given: the root budget allows no child runs.
  const model = fakeModel([
    { toolCalls: [{ name: subagentToolId, arguments: { task: 'inspect', context: 'facts' } }] },
  ]);
  const agent = expectProperty(createCarAgent({ model, limits: { maxChildRuns: 0 } }), 'value');

  // When: the model requests delegation.
  const outcome = expectProperty(await agent.generate('delegate'), 'value');

  // Then: shared admission rejects the child before another model invocation.
  assert.equal(outcome.phase, 'failed');
  assert.equal(expectProperty(expectProperty(outcome, 'error'), 'code'), 'part.budget.exhausted');
  assert.equal(model.requests.length, 1);
  await agent.dispose();
});

test('Car child allowlist permits an explicit tool but never recursive delegation', async () => {
  // Given: only echo is granted to children.
  let echoes = 0;
  const echoInput = schema(
    'test/car-echo',
    (value: unknown): value is { text: string } =>
      value !== null &&
      typeof value === 'object' &&
      'text' in value &&
      typeof value.text === 'string',
  );
  const echo = functionTool({
    id: 'echo',
    input: echoInput,
    output: stringSchema,
    execute: ({ text }) => {
      echoes++;
      return text;
    },
  });
  const model = fakeModel([
    { toolCalls: [{ name: subagentToolId, arguments: { task: 'inspect', context: 'facts' } }] },
    { toolCalls: [{ name: 'echo', arguments: { text: 'child' } }] },
    { text: 'child done' },
    { text: 'root done' },
  ]);
  const agent = expectProperty(
    createCarAgent({
      model,
      tools: [echo],
      toolSchemas: {
        echo: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      subagents: { allowedToolIds: ['echo'] },
    }),
    'value',
  );

  // When: the child calls its explicitly allowed read tool.
  const outcome = expectProperty(await agent.generate('delegate'), 'value');

  // Then: the allowlisted tool runs and the root resumes.
  assert.equal(outcome.phase, 'completed');
  assert.equal(echoes, 1);
  assert.equal(model.requests.length, 4);
  await agent.dispose();
});

test('Car never advertises recursive subagent delegation to a child', async () => {
  // Given: the child attempts the root-only delegation tool.
  const model = fakeModel([
    { toolCalls: [{ name: subagentToolId, arguments: { task: 'recurse', context: 'facts' } }] },
    { toolCalls: [{ name: subagentToolId, arguments: { task: 'nested', context: 'facts' } }] },
  ]);
  const agent = expectProperty(
    createCarAgent({ model, subagents: { allowedToolIds: [subagentToolId] } }),
    'value',
  );

  // When: the child requests nested delegation.
  const outcome = expectProperty(await agent.generate('delegate'), 'value');

  // Then: the child driver rejects an unadvertised recursive tool.
  assert.equal(outcome.phase, 'failed');
  assert.equal(
    expectProperty(expectProperty(outcome, 'error'), 'code'),
    'part.driver.tool-not-advertised',
  );
  assert.equal(model.requests.length, 2);
  await agent.dispose();
});

test('Car prepends coding instructions and preserves tool definition metadata', async () => {
  // Given: the host supplies explicit instructions and a described tool.
  const echo = functionTool({
    id: 'echo',
    description: 'Return the supplied text unchanged',
    input: stringSchema,
    output: stringSchema,
    execute: (text) => text,
  });
  const model = fakeModel([{ text: 'done' }]);
  const agent = expectProperty(
    createCarAgent({
      model,
      tools: [echo],
      toolSchemas: { echo: { type: 'string' } },
      codingInstructions: 'Configured coding policy',
    }),
    'value',
  );

  // When: the coding driver makes its first request.
  await agent.generate('work');

  // Then: the request structurally separates policy from input and advertises registry metadata.
  const body = JSON.parse(new TextDecoder().decode(expectProperty(model.requests[0], 'body')));
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.tools[0].function.description, 'Return the supplied text unchanged');
  await agent.dispose();
});

test('Car coding maxTurns defaults independently and accepts a host override', async () => {
  // Given: one allowed turn produces a tool call that would otherwise require another model request.
  const model = fakeModel([
    { toolCalls: [{ name: subagentToolId, arguments: { task: 'inspect', context: 'facts' } }] },
    { text: 'child result' },
  ]);
  const agent = expectProperty(createCarAgent({ model, maxTurns: 1 }), 'value');

  // When: the root consumes its only coding turn.
  const outcome = expectProperty(await agent.generate('delegate'), 'value');

  // Then: the coding turn bound stops the root independently of model-invocation budgets.
  assert.equal(outcome.phase, 'failed');
  assert.equal(expectProperty(expectProperty(outcome, 'error'), 'code'), 'part.driver.turn-limit');
  assert.equal(model.requests.length, 2);
  await agent.dispose();
});

test('Car exposed RunService inherits workflow parent budget and cancellation', async () => {
  // Given: a workflow context has no child-run budget.
  const model = fakeModel([{ text: 'must not run' }]);
  const agent = expectProperty(createCarAgent({ model }), 'value');
  const execution = expectProperty(await agent.executionServices(), 'value');
  const budget = createBudget({ maxChildRuns: 0 });
  const workflowContext = {
    ...execution.context,
    services: stub<Contracts.ServiceAccess>({
      get(key) {
        return key.id === budgetKey.id ? stub(ok(budget)) : execution.context.services.get(key);
      },
    }),
  };

  // When: a workflow operation starts an attached coding child through the exposed run port.
  const parent = expectProperty(
    await execution.operations.begin(
      { kind: 'part/workflow', retryOwner: 'test/workflow', childPolicy: 'attached' },
      async (context) => {
        const child = await execution.runs.start(
          {
            driver: 'part/basic',
            input: 'workflow child',
            composition: execution.composition,
            parent: { owner: 'part/operations', kind: 'part/workflow', id: context.scope.id },
          },
          context,
        );
        return child.ok
          ? child.value.done
          : {
              phase: 'failed',
              error: child.error,
              effect: 'not-attempted',
              commit: [],
              unsettledChildren: [],
            };
      },
      workflowContext,
    ),
    'value',
  );
  await parent.requestCancel('workflow-cancel');
  const outcome = await parent.done;

  // Then: child admission consumes the workflow budget and the cancelled parent drains cleanly.
  assert.equal(outcome.phase, 'cancelled');
  assert.equal(model.requests.length, 0);
  await agent.dispose();
});

test('Car exposed RunService cancels an admitted child with its workflow parent', async () => {
  // Given: an admitted workflow child is blocked in model transport.
  const base = fakeModel([]);
  const model: Convenience.ConfiguredModel & { readonly requests: Model.EncodedRequest[] } = {
    ...base,
    transport: {
      ...base.transport,
      send(_request, _profile, _auth, context) {
        return new Promise((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => resolve(fail('test.cancelled', 'Transport cancelled', 'cancelled')),
            { once: true },
          );
        });
      },
    },
  };
  const agent = expectProperty(createCarAgent({ model }), 'value');
  const execution = expectProperty(await agent.executionServices(), 'value');
  let publishChild: (handle: Runtime.ExecutionHandle<unknown>) => void = () => {};
  const childStarted = new Promise<Runtime.ExecutionHandle<unknown>>((resolve) => {
    publishChild = resolve;
  });

  // When: cancellation is requested on the owning workflow operation.
  const parent = expectProperty(
    await execution.operations.begin(
      { kind: 'part/workflow', retryOwner: 'test/workflow', childPolicy: 'attached' },
      async (context) => {
        const child = await execution.runs.start(
          {
            driver: 'part/basic',
            input: 'workflow child',
            composition: execution.composition,
            parent: { owner: 'part/operations', kind: 'part/workflow', id: context.scope.id },
          },
          context,
        );
        if (!child.ok)
          return {
            phase: 'failed',
            error: child.error,
            effect: 'not-attempted',
            commit: [],
            unsettledChildren: [],
          };
        publishChild(child.value);
        return child.value.done;
      },
      execution.context,
    ),
    'value',
  );
  const child = await childStarted;
  await parent.requestCancel('workflow-cancel');

  // Then: attached ownership propagates cancellation to the child run.
  assert.equal((await child.done).phase, 'cancelled');
  assert.equal((await parent.done).phase, 'cancelled');
  await agent.dispose();
});
