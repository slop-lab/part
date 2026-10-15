// @ts-check
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createBasicDriver } from '@slop-lab/part-plugins/agent/drivers/basic.js';
import { createScriptHooks } from '@slop-lab/part-plugins/extensions/hooks.js';
import { createScriptBridge } from '@slop-lab/part-plugins/scripts/bridge/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { createCodeEngine, defineCodeWorkflow } from '@slop-lab/part-plugins/workflows/code.js';
import { callIdentity } from '@slop-lab/part-plugins/workflows/memory/index.js';
import { createPlanner } from '@slop-lab/part/composition/index.js';
import { createContextCompiler } from '@slop-lab/part/context/index.js';
import { digest, fail, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createModelGateway } from '@slop-lab/part/model/index.js';
import { createResults } from '@slop-lab/part/results/index.js';
import { budgetKey, createBudget, createOperations } from '@slop-lab/part/runtime/index.js';
import { createRunService, installDriver } from '@slop-lab/part/runtime/runs.js';
import { createSuspensions } from '@slop-lab/part/runtime/waits.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty, json, present, stub } from '../fixtures/assertions.mjs';
import { singleService } from '../fixtures/contracts.mjs';
const context = localContext();
const delay = /** @param {number} ms */ (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {() => boolean | Promise<boolean>} predicate */
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(2);
  }
  throw Error('Condition did not arrive');
}
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
test('GW08: hook timeout/failure policies, matcher, scope and concurrent once admission are explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-hooks-matrix-'));
  try {
    const source = 'setTimeout(()=>console.log(JSON.stringify({kind:"allow"})),1000);';
    await writeFile(join(root, 'slow.cjs'), source);
    const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } });
    /** @type {import('@slop-lab/part/reference/index.js').Hooks.Point<unknown, unknown>} */
    const point = {
      id: 'test/observe',
      version: 1,
      owner: 'test',
      phase: 'observation',
      input: jsonSchema,
      output: jsonSchema,
      allowedDecisions: ['allow'],
      awaited: true,
    };
    const reports = [];
    const hooks = expectProperty(
      createScriptHooks([point], scripts, {
        match: (matcher, input) => ok(input === matcher),
        report: (_binding, error) => reports.push(error),
      }),
      'value',
    );
    /** @type {import('@slop-lab/part/reference/index.js').Hooks.Binding} */
    const binding = {
      id: 'timeout',
      pointId: point.id,
      pointVersion: 1,
      activationOwner: { owner: 'test', kind: 'run', id: context.scope.id },
      script: {
        requestId: 'slow',
        executorId: 'part/node-process',
        source: {
          relativePath: 'slow.cjs',
          digest: await digest(new TextEncoder().encode(source)),
        },
        interpreter: 'node',
        args: [],
        timeoutMs: 5,
        capture: { kind: 'stdout-json', maxBytes: 1024 },
        effects: 'read',
        retry: 'never',
      },
      failure: 'report-and-continue',
      scope: 'run',
      once: true,
      reentrancy: 'deny',
      match: 'match',
    };
    await hooks.bind(binding, context);
    assert.equal(expectProperty(await hooks.fire(point.id, 'skip', context), 'value').length, 0);
    assert.equal((await hooks.fire(point.id, 'match', context)).ok, true);
    assert.equal(reports.length, 1);
    assert.equal(expectProperty(await hooks.fire(point.id, 'match', context), 'value').length, 0);
    let executed = 0;
    /** @type {Pick<import("@slop-lab/part/reference/index.js").Scripts.Service, "execute">} */
    const counting = {
      async execute() {
        executed++;
        await delay(5);
        return ok(
          stub({
            done: Promise.resolve({
              phase: 'completed',
              result: {
                exitCode: 0,
                termination: 'exited',
                completeness: 'complete',
                executionDigest: 'fixture',
                captured: { kind: 'inline', value: { kind: 'allow' } },
              },
              effect: 'not-applied',
              commit: [],
              unsettledChildren: [],
            }),
          }),
        );
      },
    };
    const once = expectProperty(createScriptHooks([point], stub(counting)), 'value');
    await once.bind({ ...binding, id: 'once', match: undefined, failure: 'block' }, context);
    const responses = await Promise.all([
      once.fire(point.id, null, context),
      once.fire(point.id, null, context),
    ]);
    assert.equal(executed, 1);
    assert.equal(
      responses.every((response) => response.ok),
      true,
    );
    const closed = expectProperty(createScriptHooks([point], scripts), 'value');
    await closed.bind({ ...binding, id: 'fail', match: undefined, failure: 'fail-run' }, context);
    assert.equal((await closed.fire(point.id, null, context)).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('GW09: bridge expiry/revocation propagate cancellation and never widen parent reservations', async () => {
  const operations = createOperations({ cancellationGraceMs: 5 }),
    upstream = createBudget({ maxChildRuns: 0 });
  const controller = new AbortController();
  const owner = localContext({
    scope: { kind: 'runtime', id: 'bridge-owner' },
    signal: controller.signal,
    services: singleService(budgetKey, upstream),
  });
  /** @type {import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<unknown> | undefined} */
  let child;
  const bridge = createScriptBridge({
    'run.start': {
      profileRequired: true,
      async invoke(_params, c) {
        const reserve = expectProperty(c.services.get(budgetKey), 'value').reserve(
          'maxChildRuns',
          1,
        );
        return reserve.ok
          ? { kind: 'completed', commandId: '', result: null, effect: 'not-applicable', commit: [] }
          : { kind: 'rejected', commandId: '', error: expectProperty(reserve, 'error') };
      },
    },
    'model.invoke': {
      profileRequired: true,
      async invoke(_params, c) {
        child = expectProperty(
          await operations.begin(
            { kind: 'part/model', childPolicy: 'attached', retryOwner: 'test' },
            async (inner) => {
              await new Promise((resolve) =>
                inner.signal.addEventListener('abort', resolve, { once: true }),
              );
              return { phase: 'cancelled', effect: 'unknown', commit: [], unsettledChildren: [] };
            },
            c,
          ),
          'value',
        );
        return { kind: 'accepted', commandId: '', operation: child.ref, commit: [] };
      },
    },
  });
  /** @type {Omit<import('@slop-lab/part/reference/index.js').Scripts.BridgeGrant, "id">} */
  const policy = {
    version: 1,
    audience: 'test',
    owner: { owner: 'test', kind: 'run', id: owner.scope.id },
    allowedMethods: ['run.start', 'model.invoke'],
    allowedProfiles: ['local'],
    limits: { maxChildRuns: 10 },
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    enforcement: 'trusted-code-only',
  };
  const grant = expectProperty(await bridge.issue(policy, owner), 'value');
  assert.equal(
    (
      await bridge.invoke(
        { id: 'run', grantId: grant.id, method: 'run.start', params: { profileId: 'local' } },
        owner,
      )
    ).kind,
    'rejected',
  );
  assert.equal(
    (
      await bridge.invoke(
        { id: 'model', grantId: grant.id, method: 'model.invoke', params: { profileId: 'local' } },
        owner,
      )
    ).kind,
    'accepted',
  );
  await delay(1);
  await bridge.revoke(grant.id, owner);
  assert.ok(child);
  assert.equal((await child.done).phase, 'cancelled');
  const expired = expectProperty(
    await bridge.issue({ ...policy, expiresAt: new Date(Date.now() + 5).toISOString() }, owner),
    'value',
  );
  await delay(10);
  assert.equal(
    (
      await bridge.invoke(
        {
          id: 'expired',
          grantId: expired.id,
          method: 'model.invoke',
          params: { profileId: 'local' },
        },
        owner,
      )
    ).kind,
    'rejected',
  );
  bridge.close();
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

test('Bridge service adapter executes the configured gateway and exposes only its owner handles', async () => {
  const { createBridgeMethods } = await import('@slop-lab/part-plugins/scripts/bridge/services.js');
  const { messageItem } = await import('@slop-lab/part/context/index.js');
  const operations = createOperations(),
    model = fakeModel([{ text: 'bridge response' }]),
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
  const owner = localContext({ scope: { kind: 'runtime', id: 'bridge-root' } });
  const item = await messageItem('user', [{ kind: 'text', text: 'input' }]);
  const compiled = expectProperty(
    await expectProperty(createContextCompiler(), 'value').compile(
      {
        input: [item],
        sources: [item.source],
        modelCapabilities: { revision: '1', entries: [] },
        toolsDigest: 'none',
      },
      owner,
    ),
    'value',
  );
  const bridge = createScriptBridge(createBridgeMethods({ model: gateway }));
  try {
    const grant = expectProperty(
      await bridge.issue(
        {
          version: 1,
          audience: 'test',
          owner: { owner: 'test', kind: 'run', id: owner.scope.id },
          allowedMethods: ['model.invoke', 'run.get'],
          allowedProfiles: ['fake'],
          limits: { maxModelInvocations: 1 },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          enforcement: 'trusted-code-only',
        },
        owner,
      ),
      'value',
    );
    /** @type {import('@slop-lab/part/reference/index.js').Scripts.BridgeRequest} */
    const request = {
      id: 'invoke',
      grantId: grant.id,
      method: 'model.invoke',
      params: json({
        profileId: 'fake',
        invocation: { profileId: 'foreign', context: compiled, tools: [], options: {} },
      }),
    };
    const receipt = await bridge.invoke(request, owner);
    assert.equal(receipt.kind, 'accepted');
    /** @type {import('@slop-lab/part/reference/index.js').Contracts.CommandReceipt<import("@slop-lab/part/reference/index.js").Contracts.Json> | undefined} */
    let read;
    await until(async () => {
      read = await bridge.invoke(
        {
          id: crypto.randomUUID(),
          grantId: grant.id,
          method: 'run.get',
          params: { id: receipt.operation.id },
        },
        owner,
      );
      return Object.hasOwn(Object(expectProperty(read, 'result')), 'outcome');
    });
    assert.ok(read);
    assert.equal(
      expectProperty(
        expectProperty(
          expectProperty(
            expectProperty(expectProperty(expectProperty(read, 'result'), 'outcome'), 'result'),
            'content',
          ),
          0,
        ),
        'text',
      ),
      'bridge response',
    );
    assert.equal(model.requests.length, 1);
    const foreign = localContext({ scope: { kind: 'runtime', id: 'different-root' } });
    const other = expectProperty(
      await bridge.issue(
        {
          version: 1,
          audience: 'test',
          owner: { owner: 'test', kind: 'run', id: foreign.scope.id },
          allowedMethods: ['run.get'],
          allowedProfiles: [],
          limits: {},
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          enforcement: 'trusted-code-only',
        },
        foreign,
      ),
      'value',
    );
    const denied = await bridge.invoke(
      { id: 'foreign', grantId: other.id, method: 'run.get', params: { id: receipt.operation.id } },
      foreign,
    );
    assert.equal(denied.kind, 'rejected');
  } finally {
    bridge.close();
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
