import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localContext, ok, fail, jsonSchema, stringSchema, schema, digest } from 'part/contracts';
import { createOperations, createBoundary } from 'part/runtime';
import { createNodeScripts } from 'part/scripts/node';
import { createResults } from 'part/results';
import { createSuspensions } from 'part/runtime/waits';
import { createCodeEngine, defineCodeWorkflow } from 'part/workflows/code';
import { createPipelineEngine, installStepHandler } from 'part/workflows/pipeline';
import { createWorkflowHost } from 'part/workflows/host';
import { callIdentity } from 'part/workflows/memory';
import { fakeModel } from 'part/testing';
import { createModelGateway } from 'part/model';
import { messageItem, createContextCompiler } from 'part/context';
const context = localContext(),
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ref = (id, format, digest) => ({
  id,
  format,
  formatVersion: '1',
  digest,
  source: { owner: 'test', native: { entry: id } },
});
const prepare = (engine, definition) =>
  engine.prepare(
    {
      definition,
      engineId: engine.descriptor.id,
      profileId: 'default',
      requiredCapabilities: [],
      requiredControl: 'runner-enforced',
    },
    context,
  );
const terminal = async (engine, ref) => {
  for (let i = 0; i < 200; i++) {
    const snapshot = (await engine.get(ref, context)).value;
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(snapshot.phase)) return snapshot;
    await delay(2);
  }
  throw Error('Workflow did not terminate');
};
test('SR03-SR05/SR08: standalone scripts pin bytes, capture explicit JSON and reject extra/truncated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-script-test-')),
    source = 'process.stdout.write(JSON.stringify({text:"collected"}));';
  try {
    await writeFile(join(root, 'collect.cjs'), source);
    const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } }),
      request = {
        requestId: 'collect',
        executorId: 'part/node-process',
        source: {
          relativePath: 'collect.cjs',
          digest: await digest(new TextEncoder().encode(source)),
        },
        interpreter: 'node',
        args: [],
        capture: { kind: 'stdout-json', maxBytes: 1024 },
        effects: 'read',
        retry: 'never',
      };
    const captured = await scripts.execute(request, context);
    assert.equal((await captured.value.done).result.captured.value.text, 'collected');
    const uncaptured = await scripts.execute({ ...request, capture: { kind: 'none' } }, context);
    assert.equal((await uncaptured.value.done).result.captured, undefined);
    await writeFile(join(root, 'collect.cjs'), source + 'process.stdout.write("extra");');
    assert.equal((await scripts.execute(request, context)).ok, false);
    const newSource = source + 'process.stdout.write("extra");',
      changed = {
        ...request,
        source: { ...request.source, digest: await digest(new TextEncoder().encode(newSource)) },
      };
    assert.equal((await (await scripts.execute(changed, context)).value.done).phase, 'failed');
    const large = await scripts.execute(
      { ...changed, capture: { kind: 'stdout-json', maxBytes: 2 } },
      context,
    );
    assert.equal((await large.value.done).phase, 'failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('GW03/W01: code workflow executes script -> managed model -> validated result -> memory wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-code-test-')),
    source = 'process.stdout.write(JSON.stringify({text:"collected"}));';
  const operations = createOperations(),
    scripts = createNodeScripts({ root, interpreters: { node: process.execPath }, operations }),
    waits = createSuspensions(),
    results = createResults([
      { id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' },
    ]).value;
  const fake = fakeModel([{ text: 'model-result' }]),
    model = createModelGateway({
      profiles: [fake.profile],
      adapters: [fake.adapter],
      transports: [fake.transport],
      auth: { none: fake.auth },
      operations,
    }).value;
  await writeFile(join(root, 'collect.cjs'), source);
  const request = {
    requestId: 'collect',
    executorId: 'part/node-process',
    source: { relativePath: 'collect.cjs', digest: await digest(new TextEncoder().encode(source)) },
    interpreter: 'node',
    args: [],
    capture: { kind: 'stdout-json', maxBytes: 1024 },
    effects: 'read',
    retry: 'never',
  };
  let acceptedResult;
  const definition = await defineCodeWorkflow({
    id: 'code-review',
    version: '1',
    input: jsonSchema,
    output: jsonSchema,
    replay: 'none',
    async execute(input, c) {
      const collected = await c.script(
        await callIdentity(c.execution, 'collect', request),
        request,
      );
      if (collected.phase !== 'completed') return fail('fixture.script', 'Script failed');
      const item = await messageItem('user', [
        { kind: 'json', value: collected.result.captured.value },
      ]);
      const compiled = (
        await createContextCompiler().value.compile(
          {
            input: [item],
            sources: [item.source],
            modelCapabilities: { revision: '1', entries: [] },
            toolsDigest: 'none',
          },
          context,
        )
      ).value;
      const invocation = { profileId: 'fake', context: compiled, tools: [], options: {} };
      const invoked = await c.model(
        await callIdentity(c.execution, 'model', invocation),
        invocation,
      );
      if (invoked.phase !== 'completed') return fail('fixture.model', 'Model failed');
      const submission = {
        submissionId: 'result',
        expectedType: jsonSchema.ref,
        data: { kind: 'inline', value: { text: invoked.result.content[0].text } },
        producedBy: { owner: c.execution.engine, kind: 'workflow', id: c.execution.id },
        validationProfile: 'schema',
      };
      const accepted = await c.submit(
        await callIdentity(c.execution, 'result', submission),
        submission,
      );
      if (!accepted.ok) return accepted;
      acceptedResult = accepted.value;
      const spec = {
        type: 'approve',
        responseSchema: jsonSchema,
        presentation: { prompt: 'Approve?' },
        bindingDigest: accepted.value.digest,
      };
      const identity = await callIdentity(c.execution, 'approval', {
        type: spec.type,
        responseSchema: jsonSchema.ref,
        presentation: spec.presentation,
        bindingDigest: spec.bindingDigest,
      });
      const ticket = await c.wait(identity, spec);
      if (!ticket.ok) return ticket;
      const response = await c.response(ticket.value);
      if (!response.ok) return response;
      return response.value === true
        ? ok({ text: invoked.result.content[0].text })
        : fail('fixture.approval', 'Not approved');
    },
  });
  const engine = createCodeEngine([definition], {
    operations,
    scripts,
    model,
    results,
    waits,
  }).value;
  try {
    const prepared = (await prepare(engine, ref('code-review', 'part.code', definition.digest)))
      .value;
    const started = await engine.start(
      { requestId: 'code-start', idempotencyKey: 'code-start', prepared, input: {} },
      context,
    );
    assert.equal(started.kind, 'accepted');
    let waiting;
    for (let i = 0; i < 200; i++) {
      waiting = (await engine.get(started.ref, context)).value;
      if (waiting.phase === 'waiting') break;
      await delay(2);
    }
    assert.equal(waiting.phase, 'waiting');
    assert.equal(fake.requests.length, 1);
    assert.equal(acceptedResult.validation[0].status, 'pass');
    const response = {
      protocolVersion: 1,
      commandId: 'approve',
      actionId: 'part.workflow/respond',
      actionVersion: 1,
      input: { ticketId: waiting.waitingOn[0].id, revision: '0', response: true },
    };
    assert.equal((await engine.action(started.ref, response, context)).kind, 'completed');
    assert.equal((await engine.action(started.ref, response, context)).kind, 'completed');
    const done = await terminal(engine, started.ref);
    assert.equal(done.phase, 'succeeded');
    assert.equal(done.output.data.text, 'model-result');
    assert.equal(done.guarantees.checkpoint, 'none');
    const duplicate = await engine.start(
      { requestId: 'another-id', idempotencyKey: 'code-start', prepared, input: {} },
      context,
    );
    assert.equal(duplicate.ref.id, started.ref.id);
    assert.equal(
      (
        await engine.start(
          {
            requestId: 'bad',
            prepared: { ...prepared, definition: { ...prepared.definition, digest: 'forged' } },
            input: {},
          },
          context,
        )
      ).kind,
      'rejected',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('GW04/W02/W04: pipeline enforces validation/assert before write and executes all required steps', async () => {
  let writes = 0;
  const handler = installStepHandler({
    id: 'publish',
    version: 1,
    input: jsonSchema,
    output: jsonSchema,
    config: jsonSchema,
    requires: [],
    effects: 'write',
    replay: 'never',
    execute: async (value) => {
      writes++;
      return ok(value);
    },
  });
  const base = {
    format: 'part.pipeline',
    version: 1,
    id: 'pipeline',
    input: jsonSchema.ref,
    output: jsonSchema.ref,
    steps: [
      { id: 'check', after: [], kind: 'assert', value: { input: '/approved' }, equals: true },
      {
        id: 'publish',
        after: ['check'],
        kind: 'extension',
        handler: 'publish',
        handlerVersion: 1,
        input: { input: '' },
        config: {},
      },
    ],
    result: { step: 'publish', pointer: '' },
  };
  const engine = createPipelineEngine({
      definitions: [base],
      schemas: [jsonSchema],
      services: {},
      handlers: [handler],
    }).value,
    prepared = (await prepare(engine, ref('pipeline', 'part.pipeline', await digest(base)))).value;
  const bad = await engine.start(
    { requestId: 'bad', prepared, input: { approved: false } },
    context,
  );
  assert.equal((await terminal(engine, bad.ref)).phase, 'failed');
  assert.equal(writes, 0);
  const good = await engine.start(
    { requestId: 'good', prepared, input: { approved: true } },
    context,
  );
  const done = await terminal(engine, good.ref);
  assert.equal(done.phase, 'succeeded');
  assert.equal(done.effect, 'applied');
  assert.equal(writes, 1);
  const early = {
    ...base,
    id: 'early-result',
    result: { input: '' },
    steps: [
      { id: 'check', after: [], kind: 'assert', value: { input: '/approved' }, equals: true },
    ],
  };
  const earlyEngine = createPipelineEngine({
      definitions: [early],
      schemas: [jsonSchema],
      services: {},
    }).value,
    earlyPrepared = (
      await prepare(earlyEngine, ref(early.id, 'part.pipeline', await digest(early)))
    ).value;
  const failed = await earlyEngine.start(
    { requestId: 'early', prepared: earlyPrepared, input: { approved: false } },
    context,
  );
  assert.equal((await terminal(earlyEngine, failed.ref)).phase, 'failed');
});
test('W03/W14: missing engines, unsupported primitives and durable code requirements fail before effects', async () => {
  const host = createWorkflowHost([]).value;
  assert.equal(
    (
      await host.prepare(
        {
          engineId: 'missing',
          definition: ref('x', 'unknown', 'x'),
          profileId: 'default',
          requiredCapabilities: [],
          requiredControl: 'runner-enforced',
        },
        context,
      )
    ).ok,
    false,
  );
  const definition = {
    format: 'part.pipeline',
    version: 1,
    id: 'branch',
    input: jsonSchema.ref,
    output: jsonSchema.ref,
    steps: [{ id: 'branch', after: [], kind: 'branch', value: { literal: true }, cases: [] }],
    result: { literal: null },
  };
  const engine = createPipelineEngine({
    definitions: [definition],
    schemas: [jsonSchema],
    services: {},
  }).value;
  assert.equal(
    (await prepare(engine, ref('branch', 'part.pipeline', await digest(definition)))).ok,
    false,
  );
  const code = await defineCodeWorkflow({
      id: 'code',
      version: '1',
      input: jsonSchema,
      output: jsonSchema,
      replay: 'none',
      execute: async () => ok(null),
    }),
    codeEngine = createCodeEngine([code], {}).value;
  assert.equal(
    (
      await codeEngine.prepare(
        {
          engineId: codeEngine.descriptor.id,
          definition: ref('code', 'part.code', code.digest),
          profileId: 'default',
          requiredCapabilities: ['part/workflow.durable-resume'],
          requiredControl: 'runner-enforced',
        },
        context,
      )
    ).ok,
    false,
  );
});
test('W10: workflow host preserves independent native engine metadata and unknown submissions', async () => {
  const descriptor = {
    id: 'external',
    version: '7',
    forms: ['external'],
    formats: [{ id: 'native', versions: ['9'] }],
    capabilities: { revision: 'native-1', entries: [] },
  };
  const native = {
    descriptor,
    prepare: async (request) =>
      ok({
        definition: request.definition,
        engine: descriptor,
        compositionRevision: 'native-1',
        input: jsonSchema.ref,
        output: jsonSchema.ref,
        guarantees: {
          control: 'runner-enforced',
          effects: 'runner-path-only',
          checkpoint: 'engine-native',
          submissionDedupe: 'none',
          scriptCancellation: 'engine-native',
          nativeSemantics: ['native-node-replay'],
        },
        compatibility: {
          format: 'native',
          sourceVersion: '9',
          adapter: 'external',
          adapterVersion: '7',
          status: 'partial',
          ignored: [],
          semantics: ['native-node-replay'],
        },
        report: [],
        localHandle: { native: 'token' },
      }),
    start: async () => ({
      kind: 'unknown',
      requestId: 'lost',
      reconciliationKey: 'native/key',
      error: fail('external.delivery', 'Receipt lost', 'unavailable').error,
    }),
  };
  const host = createWorkflowHost([native]).value,
    prepared = (
      await host.prepare(
        {
          engineId: 'external',
          definition: { ...ref('native', 'native', 'd'), formatVersion: '9' },
          profileId: 'default',
          requiredCapabilities: [],
          requiredControl: 'runner-enforced',
        },
        context,
      )
    ).value;
  assert.equal(prepared.guarantees.checkpoint, 'engine-native');
  const submission = await host.start({ requestId: 'lost', prepared, input: {} }, context);
  assert.equal(submission.kind, 'unknown');
  assert.equal(submission.reconciliationKey, 'native/key');
});
