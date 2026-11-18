// @ts-check
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createBasicDriver } from '@slop-lab/part-plugins/agent/drivers/basic.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { createCodeEngine, defineCodeWorkflow } from '@slop-lab/part-plugins/workflows/code.js';
import { callIdentity } from '@slop-lab/part-plugins/workflows/memory/index.js';
import { createPlanner } from '@slop-lab/part/composition/index.js';
import { createContextCompiler } from '@slop-lab/part/context/index.js';
import { digest, fail, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createModelGateway } from '@slop-lab/part/model/index.js';
import { createResults } from '@slop-lab/part/results/index.js';
import { createOperations } from '@slop-lab/part/runtime/index.js';
import { createRunService, installDriver } from '@slop-lab/part/runtime/runs.js';
import { createSuspensions } from '@slop-lab/part/runtime/waits.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty, json, present } from '../fixtures/assertions.mjs';
import { until } from '../fixtures/workflow-conformance.mjs';
const context = localContext();

function composition() {
  return expectProperty(
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
}
test('GW03/GW06: actual script -> managed child agent -> typed result -> approval applies pinned data once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-vertical-')),
    source = 'console.log(JSON.stringify({text:"collected"}));';
  try {
    await writeFile(join(root, 'collect.cjs'), source);
    const operations = createOperations(),
      model = fakeModel([{ text: 'reviewed' }]),
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
    const runs = expectProperty(
      createRunService({
        drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
        services: {
          model: gateway,
          context: expectProperty(createContextCompiler(), 'value'),
          operations,
          services: context.services,
        },
        operations,
      }),
      'value',
    );
    const scripts = createNodeScripts({
      root,
      interpreters: { node: process.execPath },
      operations,
    });
    const results = expectProperty(
      createResults([
        { id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' },
      ]),
      'value',
    );
    /** @type {import('@slop-lab/part/reference/index.js').Scripts.Request} */
    const collect = {
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
    const composed = composition();
    /** @type {import('@slop-lab/part/reference/index.js').Runtime.WaitTicket | undefined} */
    let ticket;
    let applied = 0;
    const code = await defineCodeWorkflow({
      id: 'vertical',
      version: '1',
      input: jsonSchema,
      output: jsonSchema,
      replay: 'none',
      async execute(input, c) {
        const captured = await c.script(
          await callIdentity(c.execution, 'collect', json(collect)),
          collect,
        );
        if (captured.phase !== 'completed') return fail('test.collect', 'Collect failed');
        const request = {
          driver: 'part/basic',
          composition: composed,
          input: expectProperty(expectProperty(captured.result.captured, 'value'), 'text'),
        };
        const review = await c.agent(
          await callIdentity(c.execution, 'agent', {
            driver: request.driver,
            input: request.input,
            compositionRevision: composed.inspection.revision,
          }),
          request,
        );
        if (review.phase !== 'completed') return fail('test.agent', 'Agent failed');
        const text = expectProperty(
          expectProperty(expectProperty(review.result, 'content'), 0),
          'text',
        );
        assert.ok(typeof text === 'string');
        /** @type {import('@slop-lab/part/reference/index.js').Results.Submission} */
        const submission = {
          submissionId: 'result',
          expectedType: jsonSchema.ref,
          data: {
            kind: 'inline',
            value: {
              text,
              input,
            },
          },
          producedBy: { owner: c.execution.engine, kind: 'workflow', id: c.execution.id },
          validationProfile: 'schema',
        };
        const accepted = await c.submit(
          await callIdentity(c.execution, 'result', json(submission)),
          submission,
        );
        if (accepted.ok === false) return accepted;
        const spec = {
          type: 'test/approve',
          responseSchema: jsonSchema,
          presentation: { prompt: 'Approve pinned result?' },
          bindingDigest: accepted.value.digest,
        };
        const opened = await c.wait(
          await callIdentity(
            c.execution,
            'approve',
            json({
              type: spec.type,
              responseSchema: jsonSchema.ref,
              presentation: spec.presentation,
              bindingDigest: spec.bindingDigest,
            }),
          ),
          spec,
        );
        if (opened.ok === false) return opened;
        ticket = opened.value;
        const response = await c.response(ticket);
        if (response.ok === false) return response;
        if (response.value !== true) return fail('test.denied', 'Approval declined');
        applied++;
        return ok(expectProperty(accepted.value.data, 'value'));
      },
    });
    const engine = expectProperty(
      createCodeEngine([code], {
        operations,
        scripts,
        runs,
        results,
        waits: createSuspensions(),
      }),
      'value',
    );
    const prepared = expectProperty(
      await engine.prepare(
        {
          engineId: engine.descriptor.id,
          definition: {
            id: code.definition.id,
            format: 'part.code',
            formatVersion: '1',
            digest: code.digest,
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
    const started = await engine.start(
      {
        requestId: 'one',
        idempotencyKey: 'stable',
        prepared,
        input: { revision: 1 },
        limits: { maxChildRuns: 1, maxModelInvocations: 1 },
      },
      context,
    );
    await until(() => ticket !== undefined);
    assert.equal(
      (
        await engine.start(
          { requestId: 'changed', idempotencyKey: 'stable', prepared, input: { revision: 2 } },
          context,
        )
      ).kind,
      'rejected',
    );
    assert.ok(ticket);
    const command = {
      protocolVersion: 1,
      commandId: 'approve',
      actionId: 'part.workflow/respond',
      actionVersion: 1,
      input: { ticketId: ticket.id, revision: ticket.revision, response: true },
    };
    const receipts = await Promise.all([
      engine.action(expectProperty(started, 'ref'), command, context),
      engine.action(expectProperty(started, 'ref'), command, context),
    ]);
    assert.equal(receipts[0].kind, 'completed');
    assert.equal(receipts[1].kind, 'completed');
    await until(async () =>
      ['succeeded', 'failed'].includes(
        expectProperty(await engine.get(expectProperty(started, 'ref'), context), 'value').phase,
      ),
    );
    const snapshot = expectProperty(
      await engine.get(expectProperty(started, 'ref'), context),
      'value',
    );
    assert.equal(snapshot.phase, 'succeeded');
    assert.equal(applied, 1);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(expectProperty(snapshot.output, 'data'), {
      text: 'reviewed',
      input: { revision: 1 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pinned pipeline skill binding contributes explicit user instructions and releases the activation', async () => {
  const { createDirectoryPackages } = await import('@slop-lab/part-node/packages.js');
  const { createSkills, skillLowerer } =
    await import('@slop-lab/part-plugins/extensions/skills.js');
  const { messageItem, messageLowerer } = await import('@slop-lab/part/context/index.js');
  const { createPipelineEngine } =
    await import('@slop-lab/part-plugins/workflows/pipeline/index.js');
  const root = await mkdtemp(join(tmpdir(), 'part-skill-'));
  try {
    const name = 'review-skill',
      skillRoot = join(root, name);
    await mkdir(skillRoot);
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Explicit pipeline fixture\n---\nUse the pinned review instructions.`,
    );
    const source = createDirectoryPackages(),
      snapshots = expectProperty(await source.discover([skillRoot], context), 'value'),
      skills = createSkills(source, snapshots);
    const descriptor = expectProperty(await skills.list(context), 'value')[0];
    /** @type {import('@slop-lab/part/reference/index.js').Skills.Activation | undefined} */
    let activated;
    let release = 0;
    const tracked = {
      list: skills.list,
      /** @param {Parameters<typeof skills.activate>} args */
      async activate(...args) {
        const result = await skills.activate(args[0], args[1]);
        if (result.ok) activated = result.value;
        return result;
      },
      /** @param {Parameters<typeof skills.deactivate>} args */
      async deactivate(...args) {
        release++;
        return skills.deactivate(args[0], args[1]);
      },
    };
    const operations = createOperations(),
      model = fakeModel([{ text: 'skill reviewed' }]),
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
    const runs = expectProperty(
      createRunService({
        drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
        services: {
          operations,
          services: context.services,
          model: gateway,
          context: expectProperty(
            createContextCompiler({ lowerers: [messageLowerer, skillLowerer()] }),
            'value',
          ),
        },
        operations,
      }),
      'value',
    );
    const input = [await messageItem('user', [{ kind: 'text', text: 'Review this' }])],
      profile = { driver: 'part/basic', composition: composition() };
    /** @type {Parameters<typeof createPipelineEngine>[0]['definitions'][number]} */
    const definition = {
      id: 'skill-pipeline',
      format: 'part.pipeline',
      version: 1,
      input: jsonSchema.ref,
      output: jsonSchema.ref,
      steps: [
        {
          id: 'agent',
          after: [],
          kind: 'agent',
          profile: 'local',
          input: { input: '' },
          skills: [{ id: present(descriptor).id, digest: present(descriptor).package.digest }],
        },
      ],
      result: { step: 'agent', pointer: '' },
    };
    const engine = expectProperty(
      createPipelineEngine({
        definitions: [definition],
        schemas: [jsonSchema],
        services: { operations, runs },
        agents: { local: profile },
        skills: {
          service: tracked,
          bind: (input, activations) =>
            ok(
              json([
                .../** @type {import('@slop-lab/part/reference/index.js').Context.SemanticItem[]} */ (
                  /** @type {unknown} */ (input)
                ),
                ...activations.flatMap((activation) => activation.contextItems),
              ]),
            ),
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
          requiredControl: 'runner-enforced',
          requiredCapabilities: [],
        },
        context,
      ),
      'value',
    );
    const started = await engine.start({ requestId: 'one', prepared, input: json(input) }, context);
    await until(async () =>
      ['succeeded', 'failed'].includes(
        expectProperty(await engine.get(expectProperty(started, 'ref'), context), 'value').phase,
      ),
    );
    assert.equal(
      expectProperty(await engine.get(expectProperty(started, 'ref'), context), 'value').phase,
      'succeeded',
    );
    assert.equal(release, 1);
    assert.ok(activated);
    assert.equal((await skills.deactivate(activated.id, context)).ok, false);
    /** @type {{role: string, content: string}[]} */
    const messages = JSON.parse(new TextDecoder().decode(present(model.requests[0]).body)).messages;
    assert.ok(
      messages.some(
        (message) =>
          message.role === 'user' && message.content.includes('pinned review instructions'),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W12: native logical step keys attach the same managed agent run and reject changed input', async () => {
  const { createAgentStepBinding } = await import('@slop-lab/part-plugins/workflows/agent-step.js');
  const operations = createOperations(),
    model = fakeModel([{ text: 'attached once' }]),
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
  const runs = expectProperty(
    createRunService({
      drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
      services: {
        operations,
        services: context.services,
        model: gateway,
        context: expectProperty(createContextCompiler(), 'value'),
      },
      operations,
    }),
    'value',
  );
  const binding = createAgentStepBinding(runs);
  const request = { driver: 'part/basic', composition: composition(), input: 'logical input' };
  const [one, two] = await Promise.all([
    binding.startOrAttach('native/job/step', request, context),
    binding.startOrAttach('native/job/step', request, context),
  ]);
  assert.deepEqual(expectProperty(one, 'value'), expectProperty(two, 'value'));
  assert.equal(
    expectProperty(await binding.result(expectProperty(one, 'value'), context), 'value').phase,
    'completed',
  );
  assert.equal(model.requests.length, 1);
  assert.equal(
    (await binding.startOrAttach('native/job/step', { ...request, input: 'changed' }, context)).ok,
    false,
  );
  assert.equal(binding.boundary.innerAgentEffectsCheckpointed, false);
});
