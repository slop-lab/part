import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createScriptHooks } from '@slop-lab/part-plugins/extensions/hooks.js';
import { createScriptBridge } from '@slop-lab/part-plugins/scripts/bridge/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { createContextCompiler } from '@slop-lab/part/context/index.js';
import { digest, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createModelGateway } from '@slop-lab/part/model/index.js';
import { budgetKey, createBudget, createOperations } from '@slop-lab/part/runtime/index.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty, json, stub } from '../fixtures/assertions.mjs';
import { singleService } from '../fixtures/contracts.mjs';
import { delay, until } from '../fixtures/workflow-conformance.mjs';
import type { Contracts, Hooks, Runtime, Scripts } from '@slop-lab/part/reference/index.js';
const context = localContext();

test('GW08: hook timeout/failure policies, matcher, scope and concurrent once admission are explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-hooks-matrix-'));
  try {
    const source = 'setTimeout(()=>console.log(JSON.stringify({kind:"allow"})),1000);';
    await writeFile(join(root, 'slow.cjs'), source);
    const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } });
    const point: Hooks.Point<unknown, unknown> = {
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
    const binding: Hooks.Binding = {
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
    const counting: Pick<Scripts.Service, 'execute'> = {
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
  let child: Runtime.ExecutionHandle<unknown> | undefined;
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
  const policy: Omit<Scripts.BridgeGrant, 'id'> = {
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
    const request: Scripts.BridgeRequest = {
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
    let read: Contracts.CommandReceipt<Contracts.Json> | undefined;
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
