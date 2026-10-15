// @ts-check
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { createCodeEngine, defineCodeWorkflow } from '@slop-lab/part-plugins/workflows/code.js';
import { createWorkflowHost } from '@slop-lab/part-plugins/workflows/host.js';
import { callIdentity } from '@slop-lab/part-plugins/workflows/memory/index.js';
import {
  createPipelineEngine,
  installStepHandler,
} from '@slop-lab/part-plugins/workflows/pipeline/index.js';
import { createContextCompiler, messageItem } from '@slop-lab/part/context/index.js';
import { digest, fail, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createModelGateway } from '@slop-lab/part/model/index.js';
import { createResults } from '@slop-lab/part/results/index.js';
import { createOperations } from '@slop-lab/part/runtime/index.js';
import { createSuspensions } from '@slop-lab/part/runtime/waits.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty, json, present, stub } from '../fixtures/assertions.mjs';
const context = localContext(),
  delay = /** @param {number} ms */ (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {string} id @param {string} format @param {string} digest @returns {import("@slop-lab/part/reference/index.js").Workflows.DefinitionRef} */
const ref = (id, format, digest) => ({
  id,
  format,
  formatVersion: '1',
  digest,
  source: { owner: 'test', native: { entry: id } },
});
/** @param {import("@slop-lab/part/reference/index.js").Workflows.Engine} engine @param {import("@slop-lab/part/reference/index.js").Workflows.DefinitionRef} definition */
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
/** @param {import("@slop-lab/part/reference/index.js").Workflows.Engine} engine @param {import("@slop-lab/part/reference/index.js").Workflows.ExecutionRef} ref */
const terminal = async (engine, ref) => {
  for (let i = 0; i < 200; i++) {
    const snapshot = expectProperty(await engine.get(ref, context), 'value');
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
      /** @type {import('@slop-lab/part/reference/index.js').Scripts.Request} */
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
    assert.equal(
      expectProperty(
        expectProperty(
          expectProperty(await expectProperty(captured, 'value').done, 'result').captured,
          'value',
        ),
        'text',
      ),
      'collected',
    );
    const uncaptured = await scripts.execute({ ...request, capture: { kind: 'none' } }, context);
    assert.equal(
      expectProperty(await expectProperty(uncaptured, 'value').done, 'result').captured,
      undefined,
    );
    await writeFile(join(root, 'collect.cjs'), source + 'process.stdout.write("extra");');
    assert.equal((await scripts.execute(request, context)).ok, false);
    const newSource = source + 'process.stdout.write("extra");',
      /** @type {import('@slop-lab/part/reference/index.js').Scripts.Request} */
      changed = {
        ...request,
        source: { ...request.source, digest: await digest(new TextEncoder().encode(newSource)) },
      };
    assert.equal(
      (await expectProperty(await scripts.execute(changed, context), 'value').done).phase,
      'failed',
    );
    const large = await scripts.execute(
      { ...changed, capture: { kind: 'stdout-json', maxBytes: 2 } },
      context,
    );
    assert.equal((await expectProperty(large, 'value').done).phase, 'failed');
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
    results = expectProperty(
      createResults([
        { id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' },
      ]),
      'value',
    );
  const fake = fakeModel([{ text: 'model-result' }]),
    model = expectProperty(
      createModelGateway({
        profiles: [fake.profile],
        adapters: [fake.adapter],
        transports: [fake.transport],
        auth: { none: fake.auth },
        operations,
      }),
      'value',
    );
  await writeFile(join(root, 'collect.cjs'), source);
  /** @type {import('@slop-lab/part/reference/index.js').Scripts.Request} */
  const request = {
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
  /** @type {import("@slop-lab/part/reference/index.js").Results.Accepted | undefined} */
  let acceptedResult;
  const definition = await defineCodeWorkflow({
    id: 'code-review',
    version: '1',
    input: jsonSchema,
    output: jsonSchema,
    replay: 'none',
    async execute(_input, c) {
      const collected = await c.script(
        await callIdentity(c.execution, 'collect', json(request)),
        request,
      );
      if (collected.phase !== 'completed') return fail('fixture.script', 'Script failed');
      const item = await messageItem('user', [
        { kind: 'json', value: expectProperty(collected.result.captured, 'value') },
      ]);
      const compiled = expectProperty(
        await expectProperty(createContextCompiler(), 'value').compile(
          {
            input: [item],
            sources: [item.source],
            modelCapabilities: { revision: '1', entries: [] },
            toolsDigest: 'none',
          },
          context,
        ),
        'value',
      );
      const invocation = { profileId: 'fake', context: compiled, tools: [], options: {} };
      const invoked = await c.model(
        await callIdentity(c.execution, 'model', json(invocation)),
        invocation,
      );
      if (invoked.phase !== 'completed') return fail('fixture.model', 'Model failed');
      /** @type {import('@slop-lab/part/reference/index.js').Results.Submission} */
      const submission = {
        submissionId: 'result',
        expectedType: jsonSchema.ref,
        data: {
          kind: 'inline',
          value: { text: expectProperty(invoked.result.content[0], 'text') },
        },
        producedBy: { owner: c.execution.engine, kind: 'workflow', id: c.execution.id },
        validationProfile: 'schema',
      };
      const accepted = await c.submit(
        await callIdentity(c.execution, 'result', json(submission)),
        submission,
      );
      if (accepted.ok === false) return accepted;
      acceptedResult = accepted.value;
      const spec = {
        type: 'approve',
        responseSchema: jsonSchema,
        presentation: { prompt: 'Approve?' },
        bindingDigest: accepted.value.digest,
      };
      const identity = await callIdentity(
        c.execution,
        'approval',
        json({
          type: spec.type,
          responseSchema: jsonSchema.ref,
          presentation: spec.presentation,
          bindingDigest: spec.bindingDigest,
        }),
      );
      const ticket = await c.wait(identity, spec);
      if (ticket.ok === false) return ticket;
      const response = await c.response(ticket.value);
      if (response.ok === false) return response;
      return response.value === true
        ? ok({ text: expectProperty(invoked.result.content[0], 'text') })
        : fail('fixture.approval', 'Not approved');
    },
  });
  const engine = expectProperty(
    createCodeEngine([definition], {
      operations,
      scripts,
      model,
      results,
      waits,
    }),
    'value',
  );
  try {
    const prepared = expectProperty(
      await prepare(engine, ref('code-review', 'part.code', definition.digest)),
      'value',
    );
    const started = await engine.start(
      { requestId: 'code-start', idempotencyKey: 'code-start', prepared, input: {} },
      context,
    );
    assert.equal(started.kind, 'accepted');
    let waiting;
    for (let i = 0; i < 200; i++) {
      waiting = expectProperty(await engine.get(started.ref, context), 'value');
      if (waiting.phase === 'waiting') break;
      await delay(2);
    }
    assert.equal(present(waiting).phase, 'waiting');
    assert.equal(fake.requests.length, 1);
    assert.ok(acceptedResult);
    assert.equal(present(acceptedResult.validation[0]).status, 'pass');
    const response = {
      protocolVersion: 1,
      commandId: 'approve',
      actionId: 'part.workflow/respond',
      actionVersion: 1,
      input: { ticketId: present(present(waiting).waitingOn[0]).id, revision: '0', response: true },
    };
    assert.equal((await engine.action(started.ref, response, context)).kind, 'completed');
    assert.equal((await engine.action(started.ref, response, context)).kind, 'completed');
    const done = await terminal(engine, started.ref);
    assert.equal(done.phase, 'succeeded');
    assert.equal(expectProperty(expectProperty(done.output, 'data'), 'text'), 'model-result');
    assert.equal(done.guarantees.checkpoint, 'none');
    const duplicate = await engine.start(
      { requestId: 'another-id', idempotencyKey: 'code-start', prepared, input: {} },
      context,
    );
    assert.equal(expectProperty(duplicate, 'ref').id, started.ref.id);
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
  /** @type {Parameters<typeof createPipelineEngine>[0]['definitions'][number]} */
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
  const engine = expectProperty(
      createPipelineEngine({
        definitions: [base],
        schemas: [jsonSchema],
        services: {},
        handlers: [handler],
      }),
      'value',
    ),
    prepared = expectProperty(
      await prepare(engine, ref('pipeline', 'part.pipeline', await digest(json(base)))),
      'value',
    );
  const bad = await engine.start(
    { requestId: 'bad', prepared, input: { approved: false } },
    context,
  );
  assert.equal((await terminal(engine, expectProperty(bad, 'ref'))).phase, 'failed');
  assert.equal(writes, 0);
  const good = await engine.start(
    { requestId: 'good', prepared, input: { approved: true } },
    context,
  );
  const done = await terminal(engine, expectProperty(good, 'ref'));
  assert.equal(done.phase, 'succeeded');
  assert.equal(done.effect, 'applied');
  assert.equal(writes, 1);
  /** @type {Parameters<typeof createPipelineEngine>[0]['definitions'][number]} */
  const early = {
    ...base,
    id: 'early-result',
    result: { input: '' },
    steps: [
      { id: 'check', after: [], kind: 'assert', value: { input: '/approved' }, equals: true },
    ],
  };
  const earlyEngine = expectProperty(
      createPipelineEngine({
        definitions: [early],
        schemas: [jsonSchema],
        services: {},
      }),
      'value',
    ),
    earlyPrepared = expectProperty(
      await prepare(
        earlyEngine,
        ref(expectProperty(early, 'id'), 'part.pipeline', await digest(json(early))),
      ),
      'value',
    );
  const failed = await earlyEngine.start(
    { requestId: 'early', prepared: earlyPrepared, input: { approved: false } },
    context,
  );
  assert.equal((await terminal(earlyEngine, expectProperty(failed, 'ref'))).phase, 'failed');
});
test('W03/W14: missing engines, unsupported primitives and durable code requirements fail before effects', async () => {
  const host = expectProperty(createWorkflowHost([]), 'value');
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
  /** @type {Parameters<typeof createPipelineEngine>[0]['definitions'][number]} */
  const definition = {
    format: 'part.pipeline',
    version: 1,
    id: 'branch',
    input: jsonSchema.ref,
    output: jsonSchema.ref,
    steps: [{ id: 'branch', after: [], kind: 'branch', value: { literal: true }, cases: [] }],
    result: { literal: null },
  };
  const engine = expectProperty(
    createPipelineEngine({
      definitions: [definition],
      schemas: [jsonSchema],
      services: {},
    }),
    'value',
  );
  assert.equal(
    (await prepare(engine, ref('branch', 'part.pipeline', await digest(json(definition))))).ok,
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
    codeEngine = expectProperty(createCodeEngine([code], {}), 'value');
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
  /** @type {import("@slop-lab/part/reference/index.js").Workflows.EngineDescriptor} */
  const descriptor = {
    id: 'external',
    version: '7',
    forms: ['external'],
    formats: [{ id: 'native', versions: ['9'] }],
    capabilities: { revision: 'native-1', entries: [] },
  };
  /** @type {Partial<import("@slop-lab/part/reference/index.js").Workflows.Engine>} */
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
  const host = expectProperty(createWorkflowHost([stub(native)]), 'value'),
    prepared = expectProperty(
      await host.prepare(
        {
          engineId: 'external',
          definition: { ...ref('native', 'native', 'd'), formatVersion: '9' },
          profileId: 'default',
          requiredCapabilities: [],
          requiredControl: 'runner-enforced',
        },
        context,
      ),
      'value',
    );
  assert.equal(prepared.guarantees.checkpoint, 'engine-native');
  const submission = await host.start({ requestId: 'lost', prepared, input: {} }, context);
  assert.equal(submission.kind, 'unknown');
  assert.equal(submission.reconciliationKey, 'native/key');
});
