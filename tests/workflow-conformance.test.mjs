import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localContext, ok, fail, jsonSchema, digest } from '@slop-lab/part/contracts';
import { createOperations, createBudget, budgetKey } from '@slop-lab/part/runtime';
import { createPlanner } from '@slop-lab/part/composition';
import { createBasicDriver } from '@slop-lab/part-plugins/agent/drivers/basic';
import { createRunService, installDriver } from '@slop-lab/part/runtime/runs';
import { createModelGateway } from '@slop-lab/part/model';
import { fakeModel } from '@slop-lab/part-plugins/testing';
import { createContextCompiler } from '@slop-lab/part/context';
import { createNodeScripts } from '@slop-lab/part-node/scripts';
import { createResults } from '@slop-lab/part/results';
import { createSuspensions } from '@slop-lab/part/runtime/waits';
import { createCodeEngine, defineCodeWorkflow } from '@slop-lab/part-plugins/workflows/code';
import { callIdentity } from '@slop-lab/part-plugins/workflows/memory';
import { createScriptBridge } from '@slop-lab/part-plugins/scripts/bridge';
import { createScriptHooks } from '@slop-lab/part-plugins/extensions/hooks';
const context = localContext();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(2);
  }
  throw Error('Condition did not arrive');
}
function composition() {
  return createPlanner().resolve({
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
}
test(
  'GW03/GW06: actual script -> managed child agent -> typed result -> approval applies pinned data once',
  { skip: process.platform === 'win32' && 'Requires POSIX process groups' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'part-vertical-')),
      source = 'console.log(JSON.stringify({text:"collected"}));';
    try {
      await writeFile(join(root, 'collect.cjs'), source);
      const operations = createOperations(),
        model = fakeModel([{ text: 'reviewed' }]),
        gateway = createModelGateway({
          profiles: [model.profile],
          adapters: [model.adapter],
          transports: [model.transport],
          auth: { none: model.auth },
          operations,
        }).value;
      const runs = createRunService({
        drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
        services: {
          model: gateway,
          context: createContextCompiler().value,
          operations,
          services: context.services,
        },
        operations,
      }).value;
      const scripts = createNodeScripts({
        root,
        interpreters: { node: process.execPath },
        operations,
      });
      const results = createResults([
        { id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' },
      ]).value;
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
      let ticket,
        applied = 0;
      const code = await defineCodeWorkflow({
        id: 'vertical',
        version: '1',
        input: jsonSchema,
        output: jsonSchema,
        replay: 'none',
        async execute(input, c) {
          const captured = await c.script(
            await callIdentity(c.execution, 'collect', collect),
            collect,
          );
          if (captured.phase !== 'completed') return fail('test.collect', 'Collect failed');
          const request = {
            driver: 'part/basic',
            composition: composed,
            input: captured.result.captured.value.text,
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
          const submission = {
            submissionId: 'result',
            expectedType: jsonSchema.ref,
            data: { kind: 'inline', value: { text: review.result.content[0].text, input } },
            producedBy: { owner: c.execution.engine, kind: 'workflow', id: c.execution.id },
            validationProfile: 'schema',
          };
          const accepted = await c.submit(
            await callIdentity(c.execution, 'result', submission),
            submission,
          );
          if (!accepted.ok) return accepted;
          const spec = {
            type: 'test/approve',
            responseSchema: jsonSchema,
            presentation: { prompt: 'Approve pinned result?' },
            bindingDigest: accepted.value.digest,
          };
          const opened = await c.wait(
            await callIdentity(c.execution, 'approve', {
              type: spec.type,
              responseSchema: jsonSchema.ref,
              presentation: spec.presentation,
              bindingDigest: spec.bindingDigest,
            }),
            spec,
          );
          if (!opened.ok) return opened;
          ticket = opened.value;
          const response = await c.response(ticket);
          if (!response.ok) return response;
          if (response.value !== true) return fail('test.denied', 'Approval declined');
          applied++;
          return ok(accepted.value.data.value);
        },
      });
      const engine = createCodeEngine([code], {
        operations,
        scripts,
        runs,
        results,
        waits: createSuspensions(),
      }).value;
      const prepared = (
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
        )
      ).value;
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
      const command = {
        protocolVersion: 1,
        commandId: 'approve',
        actionId: 'part.workflow/respond',
        actionVersion: 1,
        input: { ticketId: ticket.id, revision: ticket.revision, response: true },
      };
      const receipts = await Promise.all([
        engine.action(started.ref, command, context),
        engine.action(started.ref, command, context),
      ]);
      assert.equal(receipts[0].kind, 'completed');
      assert.equal(receipts[1].kind, 'completed');
      await until(async () =>
        ['succeeded', 'failed'].includes((await engine.get(started.ref, context)).value.phase),
      );
      const snapshot = (await engine.get(started.ref, context)).value;
      assert.equal(snapshot.phase, 'succeeded');
      assert.equal(applied, 1);
      assert.equal(model.requests.length, 1);
      assert.deepEqual(snapshot.output.data, { text: 'reviewed', input: { revision: 1 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
test('GW08: hook timeout/failure policies, matcher, scope and concurrent once admission are explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-hooks-matrix-'));
  try {
    const source = 'setTimeout(()=>console.log(JSON.stringify({kind:"allow"})),1000);';
    await writeFile(join(root, 'slow.cjs'), source);
    const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } });
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
    const hooks = createScriptHooks([point], scripts, {
      match: (matcher, input) => ok(input === matcher),
      report: (_binding, error) => reports.push(error),
    }).value;
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
    assert.equal((await hooks.fire(point.id, 'skip', context)).value.length, 0);
    assert.equal((await hooks.fire(point.id, 'match', context)).ok, true);
    assert.equal(reports.length, 1);
    assert.equal((await hooks.fire(point.id, 'match', context)).value.length, 0);
    let executed = 0;
    const counting = {
      async execute() {
        executed++;
        await delay(5);
        return ok({
          done: Promise.resolve({
            phase: 'completed',
            result: { exitCode: 0, captured: { kind: 'inline', value: { kind: 'allow' } } },
            effect: 'not-applied',
            commit: [],
            unsettledChildren: [],
          }),
        });
      },
    };
    const once = createScriptHooks([point], counting).value;
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
    const closed = createScriptHooks([point], scripts).value;
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
    services: {
      get: (key) => (key.id === budgetKey.id ? ok(upstream) : fail('missing', 'Missing service')),
    },
  });
  let child;
  const bridge = createScriptBridge({
    'run.start': {
      profileRequired: true,
      async invoke(_params, c) {
        const reserve = c.services.get(budgetKey).value.reserve('maxChildRuns', 1);
        return reserve.ok
          ? { kind: 'completed', commandId: '', result: null, effect: 'not-applicable', commit: [] }
          : { kind: 'rejected', commandId: '', error: reserve.error };
      },
    },
    'model.invoke': {
      profileRequired: true,
      async invoke(_params, c) {
        child = (
          await operations.begin(
            { kind: 'part/model', childPolicy: 'attached', retryOwner: 'test' },
            async (inner) => {
              await new Promise((resolve) =>
                inner.signal.addEventListener('abort', resolve, { once: true }),
              );
              return { phase: 'cancelled', effect: 'unknown', commit: [], unsettledChildren: [] };
            },
            c,
          )
        ).value;
        return { kind: 'accepted', commandId: '', operation: child.ref, commit: [] };
      },
    },
  });
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
  const grant = (await bridge.issue(policy, owner)).value;
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
  assert.equal((await child.done).phase, 'cancelled');
  const expired = (
    await bridge.issue({ ...policy, expiresAt: new Date(Date.now() + 5).toISOString() }, owner)
  ).value;
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
  const { createDirectoryPackages } = await import('@slop-lab/part-node/packages');
  const { createSkills, skillLowerer } = await import('@slop-lab/part-plugins/extensions/skills');
  const { messageItem, messageLowerer } = await import('@slop-lab/part/context');
  const { createPipelineEngine } = await import('@slop-lab/part-plugins/workflows/pipeline');
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
      snapshots = (await source.discover([skillRoot], context)).value,
      skills = createSkills(source, snapshots);
    const descriptor = (await skills.list(context)).value[0];
    let activated,
      release = 0;
    const tracked = {
      list: skills.list,
      async activate(...args) {
        const result = await skills.activate(...args);
        if (result.ok) activated = result.value;
        return result;
      },
      async deactivate(...args) {
        release++;
        return skills.deactivate(...args);
      },
    };
    const operations = createOperations(),
      model = fakeModel([{ text: 'skill reviewed' }]),
      gateway = createModelGateway({
        profiles: [model.profile],
        adapters: [model.adapter],
        transports: [model.transport],
        auth: { none: model.auth },
        operations,
      }).value;
    const runs = createRunService({
      drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
      services: {
        operations,
        services: context.services,
        model: gateway,
        context: createContextCompiler({ lowerers: [messageLowerer, skillLowerer()] }).value,
      },
      operations,
    }).value;
    const input = [await messageItem('user', [{ kind: 'text', text: 'Review this' }])],
      profile = { driver: 'part/basic', composition: composition() };
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
          skills: [{ id: descriptor.id, digest: descriptor.package.digest }],
        },
      ],
      result: { step: 'agent', pointer: '' },
    };
    const engine = createPipelineEngine({
      definitions: [definition],
      schemas: [jsonSchema],
      services: { operations, runs },
      agents: { local: profile },
      skills: {
        service: tracked,
        bind: (input, activations) =>
          ok([...input, ...activations.flatMap((activation) => activation.contextItems)]),
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
          requiredControl: 'runner-enforced',
          requiredCapabilities: [],
        },
        context,
      )
    ).value;
    const started = await engine.start({ requestId: 'one', prepared, input }, context);
    await until(async () =>
      ['succeeded', 'failed'].includes((await engine.get(started.ref, context)).value.phase),
    );
    assert.equal((await engine.get(started.ref, context)).value.phase, 'succeeded');
    assert.equal(release, 1);
    assert.equal((await skills.deactivate(activated.id, context)).ok, false);
    const messages = JSON.parse(new TextDecoder().decode(model.requests[0].body)).messages;
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
  const { createBridgeMethods } = await import('@slop-lab/part-plugins/scripts/bridge/services');
  const { messageItem } = await import('@slop-lab/part/context');
  const operations = createOperations(),
    model = fakeModel([{ text: 'bridge response' }]),
    gateway = createModelGateway({
      profiles: [model.profile],
      adapters: [model.adapter],
      transports: [model.transport],
      auth: { none: model.auth },
      operations,
    }).value;
  const owner = localContext({ scope: { kind: 'runtime', id: 'bridge-root' } });
  const item = await messageItem('user', [{ kind: 'text', text: 'input' }]);
  const compiled = (
    await createContextCompiler().value.compile(
      {
        input: [item],
        sources: [item.source],
        modelCapabilities: { revision: '1', entries: [] },
        toolsDigest: 'none',
      },
      owner,
    )
  ).value;
  const bridge = createScriptBridge(createBridgeMethods({ model: gateway }));
  try {
    const grant = (
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
      )
    ).value;
    const request = {
      id: 'invoke',
      grantId: grant.id,
      method: 'model.invoke',
      params: {
        profileId: 'fake',
        invocation: { profileId: 'foreign', context: compiled, tools: [], options: {} },
      },
    };
    const receipt = await bridge.invoke(request, owner);
    assert.equal(receipt.kind, 'accepted');
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
      return read.result?.outcome !== undefined;
    });
    assert.equal(read.result.outcome.result.content[0].text, 'bridge response');
    assert.equal(model.requests.length, 1);
    const foreign = localContext({ scope: { kind: 'runtime', id: 'different-root' } });
    const other = (
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
      )
    ).value;
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
  const { createAgentStepBinding } = await import('@slop-lab/part-plugins/workflows/agent-step');
  const operations = createOperations(),
    model = fakeModel([{ text: 'attached once' }]),
    gateway = createModelGateway({
      profiles: [model.profile],
      adapters: [model.adapter],
      transports: [model.transport],
      auth: { none: model.auth },
      operations,
    }).value;
  const runs = createRunService({
    drivers: [installDriver(createBasicDriver({ profileId: 'fake' }))],
    services: {
      operations,
      services: context.services,
      model: gateway,
      context: createContextCompiler().value,
    },
    operations,
  }).value;
  const binding = createAgentStepBinding(runs);
  const request = { driver: 'part/basic', composition: composition(), input: 'logical input' };
  const [one, two] = await Promise.all([
    binding.startOrAttach('native/job/step', request, context),
    binding.startOrAttach('native/job/step', request, context),
  ]);
  assert.deepEqual(one.value, two.value);
  assert.equal((await binding.result(one.value, context)).value.phase, 'completed');
  assert.equal(model.requests.length, 1);
  assert.equal(
    (await binding.startOrAttach('native/job/step', { ...request, input: 'changed' }, context)).ok,
    false,
  );
  assert.equal(binding.boundary.innerAgentEffectsCheckpointed, false);
});
