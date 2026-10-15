import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { localContext, jsonSchema, ok, fail, digest } from 'part/contracts';
import { createCodeEngine, defineCodeWorkflow } from 'part/workflows/code';
import { createPipelineEngine, installStepHandler } from 'part/workflows/pipeline';
import { createWorkflowHost } from 'part/workflows/host';
import { createWorkflowEndpoint } from 'part/workflows/endpoint';
import { createSuspensions } from 'part/runtime/waits';
import { callIdentity } from 'part/workflows/memory';
import { createLocalPort, createController, jsonCodec } from 'part/client';
import { createWorkflowView } from 'part/ui/workflow';
const context = localContext();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(2);
  }
  throw Error('Condition did not arrive');
}
const ref = (definition, format, hash) => ({
  id: definition.id,
  format,
  formatVersion: '1',
  digest: hash,
  source: { owner: 'test', native: {} },
});
async function startPipeline(definition, handlers = []) {
  const engine = createPipelineEngine({
    definitions: [definition],
    schemas: [jsonSchema],
    services: {},
    handlers,
  }).value;
  const prepared = await engine.prepare(
    {
      engineId: engine.descriptor.id,
      definition: ref(definition, 'part.pipeline', await digest(definition)),
      profileId: 'default',
      requiredCapabilities: [],
      requiredControl: 'runner-enforced',
    },
    context,
  );
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const started = await engine.start(
    { requestId: crypto.randomUUID(), prepared: prepared.value, input: {} },
    context,
  );
  await until(async () =>
    ['succeeded', 'failed', 'cancelled', 'unknown'].includes(
      (await engine.get(started.ref, context)).value.phase,
    ),
  );
  return (await engine.get(started.ref, context)).value;
}
const assertion = (id, value) => ({
  id,
  after: [],
  kind: 'assert',
  value: { literal: value },
  equals: value,
});
const pipeline = (steps) => ({
  id: 'nested',
  format: 'part.pipeline',
  version: 1,
  input: jsonSchema.ref,
  output: jsonSchema.ref,
  steps,
  result: { step: steps[0].id, pointer: '' },
});
test('Pipeline lexical branches, bounded repeat and ordered parallel results execute required blocks', async () => {
  let iterations = 0;
  const next = installStepHandler({
    id: 'test/next',
    version: 1,
    input: jsonSchema,
    output: jsonSchema,
    config: jsonSchema,
    requires: [],
    effects: 'read',
    replay: 'never',
    execute: async () => ok(++iterations),
  });
  const repeat = {
    id: 'repeat',
    after: [],
    kind: 'repeat',
    maxIterations: 3,
    body: [
      {
        id: 'next',
        after: [],
        kind: 'extension',
        handler: next.id,
        handlerVersion: 1,
        input: { literal: null },
        config: {},
      },
    ],
    until: { value: { step: 'next', pointer: '' }, equals: 2 },
  };
  const definition = pipeline([
    {
      id: 'choose',
      after: [],
      kind: 'branch',
      value: { literal: true },
      cases: [{ equals: true, run: [repeat] }],
      otherwise: [assertion('no', false)],
    },
  ]);
  const snapshot = await startPipeline(definition, [next]);
  assert.equal(snapshot.phase, 'succeeded');
  assert.equal(snapshot.output.data, 2);
  assert.equal(iterations, 2);
  const parallel = pipeline([
    {
      id: 'parallel',
      after: [],
      kind: 'parallel',
      maxConcurrency: 2,
      onError: 'collect',
      branches: [[assertion('same', 1)], [assertion('same', 2)]],
    },
  ]);
  assert.deepEqual((await startPipeline(parallel)).output.data, [1, 2]);
  const exceeded = await startPipeline(pipeline([{ ...repeat, maxIterations: 1 }]), [next]);
  assert.equal(exceeded.phase, 'failed');
});
test('Pipeline cancel-and-join aborts sibling managed steps; per-step timeout prevents later writes', async () => {
  let writes = 0,
    cancelled = false,
    slowStarted = false;
  const slow = installStepHandler({
    id: 'test/slow',
    version: 1,
    input: jsonSchema,
    output: jsonSchema,
    config: jsonSchema,
    requires: [],
    effects: 'read',
    replay: 'never',
    execute: async (_input, _config, _identity, context) => {
      slowStarted = true;
      await new Promise((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', resolve, { once: true });
      });
      cancelled = true;
      return ok(null);
    },
  });
  const write = installStepHandler({
    id: 'test/write',
    version: 1,
    input: jsonSchema,
    output: jsonSchema,
    config: jsonSchema,
    requires: [],
    effects: 'write',
    replay: 'never',
    execute: async () => {
      writes++;
      return ok(null);
    },
  });
  const slowStep = {
    id: 'slow',
    after: [],
    kind: 'extension',
    handler: slow.id,
    handlerVersion: 1,
    input: { literal: null },
    config: {},
  };
  const failHandler = installStepHandler({
    id: 'test/fail',
    version: 1,
    input: jsonSchema,
    output: jsonSchema,
    config: jsonSchema,
    requires: [],
    effects: 'read',
    replay: 'never',
    async execute() {
      await until(() => slowStarted);
      return fail('test.failure', 'Required branch failed');
    },
  });
  const failStep = {
    id: 'fail',
    after: [],
    kind: 'extension',
    handler: failHandler.id,
    handlerVersion: 1,
    input: { literal: null },
    config: {},
  };
  const definition = pipeline([
    {
      id: 'parallel',
      after: [],
      kind: 'parallel',
      maxConcurrency: 2,
      onError: 'cancel-and-join',
      branches: [[slowStep], [failStep]],
    },
  ]);
  assert.equal((await startPipeline(definition, [slow, failHandler])).phase, 'failed');
  assert.equal(cancelled, true);
  const timed = pipeline([
    { ...slowStep, timeoutMs: 5 },
    {
      id: 'write',
      after: ['slow'],
      kind: 'extension',
      handler: write.id,
      handlerVersion: 1,
      input: { literal: null },
      config: {},
    },
  ]);
  assert.equal((await startPipeline(timed, [slow, write])).phase, 'failed');
  assert.equal(writes, 0);
});
test('Generic workflow endpoint and default DOM show waits, invoke owner response and display results without native state', async () => {
  let applied = 0;
  const code = await defineCodeWorkflow({
    id: 'approval',
    version: '1',
    input: jsonSchema,
    output: jsonSchema,
    replay: 'none',
    async execute(input, steps) {
      const spec = {
        type: 'test/approve',
        responseSchema: jsonSchema,
        presentation: { prompt: 'Approve this fixed result?' },
        bindingDigest: await digest(input),
      };
      const identity = await callIdentity(steps.execution, 'approve', {
        type: spec.type,
        responseSchema: jsonSchema.ref,
        presentation: spec.presentation,
        bindingDigest: spec.bindingDigest,
      });
      const wait = await steps.wait(identity, spec);
      if (!wait.ok) return wait;
      const response = await steps.response(wait.value);
      if (!response.ok) return response;
      if (response.value !== true) return ok({ applied: false });
      applied++;
      return ok({ applied: true });
    },
  });
  const engine = createCodeEngine([code], { waits: createSuspensions() }).value;
  const definition = ref(code.definition, 'part.code', code.digest);
  // defineCodeWorkflow exposes the ID on its definition.
  const endpointResult = createWorkflowEndpoint({
    host: createWorkflowHost([engine]).value,
    registrations: [{ definition, engineId: engine.descriptor.id, profileIds: ['default'] }],
    composition: { id: 'test', revision: '1' },
    context,
  });
  assert.equal(endpointResult.ok, true);
  const endpoint = endpointResult.value;
  const controller = createController(
    createLocalPort(endpoint, () => context, { codec: jsonCodec, codecLoopback: true }),
  );
  const window = new Window();
  const view = createWorkflowView({ client: controller, document: window.document });
  window.document.body.append(view.element);
  try {
    await controller.connect({ surface: 'workflow' });
    const input = {
      engineId: engine.descriptor.id,
      definition: { id: definition.id, digest: definition.digest },
      profileId: 'default',
      composition: { id: 'test', revision: '1' },
      input: { fixed: 1 },
      requiredControl: 'runner-enforced',
      requiredCapabilities: [],
    };
    const command = {
      protocolVersion: 1,
      commandId: 'start',
      actionId: 'part.workflow/start',
      actionVersion: 1,
      input,
    };
    const started = await controller.invoke(command);
    assert.equal(started.kind, 'receipt');
    assert.equal(started.receipt.kind, 'accepted', JSON.stringify(started));
    assert.equal(
      (await controller.invoke({ ...command, input: { ...input, input: { fixed: 2 } } })).receipt
        .kind,
      'rejected',
    );
    await until(() => view.element.textContent.includes('Approve this fixed result?'));
    const textarea = view.element.querySelector(
      'textarea[aria-label="JSON input for part.workflow/respond"]',
    );
    const response = JSON.parse(textarea.value);
    response.response = true;
    textarea.value = JSON.stringify(response);
    textarea.dispatchEvent(new window.Event('input'));
    textarea
      .closest('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => view.element.textContent.includes('State: succeeded'));
    assert.equal(applied, 1);
    assert.ok(view.element.querySelector('[aria-label="Workflow result"]'));
    const item = controller.getItem(started.receipt.operation.id);
    assert.equal(item.payload.nativeState, undefined);
    assert.equal(
      (
        await endpoint.query(
          {
            queryId: 'part.workflow/get',
            version: 1,
            target: started.receipt.operation,
            input: null,
          },
          localContext({ principal: { subject: 'foreign', authority: 'test' } }),
        )
      ).ok,
      false,
    );
    await controller.disconnect();
    assert.equal(applied, 1);
  } finally {
    await view.dispose();
    await controller.dispose();
    await endpoint.close();
    await window.happyDOM.close();
  }
});
