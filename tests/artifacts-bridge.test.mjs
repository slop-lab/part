// @ts-check
import { openFileArtifacts } from '@slop-lab/part-node/artifacts.js';
import { startScriptBridge } from '@slop-lab/part-node/scripts/bridge.js';
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createScriptBridge } from '@slop-lab/part-plugins/scripts/bridge/index.js';
import { createMemoryArtifacts } from '@slop-lab/part/artifacts/index.js';
import { provenance } from '@slop-lab/part/context/index.js';
import { digest, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createResults } from '@slop-lab/part/results/index.js';
import { budgetKey, createBudget } from '@slop-lab/part/runtime/index.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deferred, expectProperty } from '../fixtures/assertions.mjs';
import { singleService } from '../fixtures/contracts.mjs';
const context = localContext();
const metadata = { mediaType: 'application/json', provenance };
test('Artifacts publish only complete immutable bytes, authorize ranges and survive reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-artifacts-'));
  try {
    for (const store of [createMemoryArtifacts({ maxBytes: 16 }), await openFileArtifacts(root)]) {
      const writer = expectProperty(await store.create(metadata, context), 'value');
      const bytes = new TextEncoder().encode('{"x":1}');
      assert.equal((await writer.write(bytes)).ok, true);
      bytes.fill(0);
      const finalized = expectProperty(await writer.finalize(), 'value');
      assert.equal((await writer.write(new Uint8Array())).ok, false);
      assert.deepEqual(expectProperty(await writer.finalize(), 'value'), finalized);
      const reader = finalized.durability === 'durable' ? await openFileArtifacts(root) : store;
      const loaded = expectProperty(
        await reader.read(finalized.ref, { start: 5, length: 1 }, context),
        'value',
      );
      for await (const chunk of loaded) assert.equal(new TextDecoder().decode(chunk), '1');
      assert.equal((await reader.read(finalized.ref, { start: -1, length: 1 }, context)).ok, false);
      assert.equal(
        (
          await reader.read(
            finalized.ref,
            undefined,
            localContext({ principal: { subject: 'other', authority: 'test' } }),
          )
        ).ok,
        false,
      );
    }
    const small = createMemoryArtifacts({ maxBytes: 1 });
    const writer = expectProperty(await small.create(metadata, context), 'value');
    assert.equal((await writer.write(new Uint8Array(2))).ok, false);
    assert.equal((await writer.finalize()).ok, false);
    const aborted = expectProperty(await small.create(metadata, context), 'value');
    await aborted.abort();
    assert.equal((await aborted.finalize()).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Results pin artifact bytes and deduplicate concurrent processors; bad processor evidence never accepts', async () => {
  const artifacts = createMemoryArtifacts();
  const writer = expectProperty(await artifacts.create(metadata, context), 'value');
  await writer.write(new TextEncoder().encode('{"x":1}'));
  const artifact = expectProperty(await writer.finalize(), 'value');
  let calls = 0;
  /** @type {import('@slop-lab/part/reference/index.js').Results.Processor} */
  const processor = {
    id: 'test/normalize',
    version: '1',
    inputType: jsonSchema.ref,
    outputType: jsonSchema.ref,
    async process(input) {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      const x = expectProperty(expectProperty(input, 'value'), 'x');
      assert.ok(typeof x === 'number');
      const output = {
        kind: /** @type {const} */ ('inline'),
        value: { x: x + 1 },
      };
      return ok({
        output,
        evidence: {
          validator: 'test/normalize',
          version: '1',
          status: 'pass',
          inputDigest: await digest(expectProperty(input, 'value')),
          outputDigest: await digest(output.value),
          diagnostics: [],
        },
      });
    },
  };
  const results = expectProperty(
    createResults(
      [{ id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' }],
      { artifacts, processors: [processor], profiles: { normalize: [processor.id] } },
    ),
    'value',
  );
  /** @type {import('@slop-lab/part/reference/index.js').Results.Submission} */
  const submission = {
    submissionId: 'one',
    expectedType: jsonSchema.ref,
    data: { kind: 'artifact', ref: artifact.ref, expectedDigest: artifact.digest },
    producedBy: { owner: 'test', kind: 'run', id: 'one' },
    validationProfile: 'normalize',
  };
  const accepted = await Promise.all([
    results.submit(submission, context),
    results.submit(submission, context),
  ]);
  assert.equal(calls, 1);
  assert.equal(accepted[0].ok, true);
  assert.equal(accepted[0].value.id, expectProperty(accepted[1], 'value').id);
  assert.deepEqual(expectProperty(accepted[0].value.data, 'value'), { x: 2 });
  assert.equal(
    (
      await results.submit(
        {
          ...submission,
          submissionId: 'two',
          data: { kind: 'artifact', ref: artifact.ref, expectedDigest: 'stale' },
        },
        context,
      )
    ).ok,
    false,
  );
  const broken = expectProperty(
    createResults(
      [{ id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' }],
      {
        processors: [
          {
            ...processor,
            // @ts-expect-error Malformed processor evidence must be rejected at runtime.
            process: async () => ok({ output: { kind: 'inline', value: {} }, evidence: {} }),
          },
        ],
        profiles: { normalize: [processor.id] },
      },
    ),
    'value',
  );
  assert.equal(
    (await broken.submit({ ...submission, data: { kind: 'inline', value: {} } }, context)).ok,
    false,
  );
});
test('Authenticated bridge rejects public IDs, profile widening and changed IDs; script uses real RPC with parent budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-bridge-'));
  const upstream = createBudget({ maxModelInvocations: 1 });
  const owner = localContext({
    scope: { kind: 'runtime', id: 'owner' },
    services: singleService(budgetKey, upstream),
  });
  let calls = 0;
  const bridge = createScriptBridge({
    'model.invoke': {
      profileRequired: true,
      async invoke(params, context) {
        calls++;
        const budget = expectProperty(context.services.get(budgetKey), 'value').reserve(
          'maxModelInvocations',
          1,
        );
        return budget.ok
          ? {
              kind: 'completed',
              commandId: '',
              result: {
                actor: context.principal.subject,
                value: expectProperty(params, 'value'),
              },
              effect: 'not-applied',
              commit: [],
            }
          : { kind: 'rejected', commandId: '', error: expectProperty(budget, 'error') };
      },
    },
  });
  const transport = expectProperty(await startScriptBridge(bridge), 'value');
  try {
    const grant = expectProperty(
      await bridge.issue(
        {
          version: 1,
          audience: 'bridge.mjs',
          owner: { owner: 'test', kind: 'run', id: owner.scope.id },
          allowedMethods: ['model.invoke'],
          allowedProfiles: ['local'],
          limits: { maxModelInvocations: 2 },
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          enforcement: 'authenticated-channel',
        },
        owner,
      ),
      'value',
    );
    const env = expectProperty(transport.environment(grant.id, owner), 'value');
    const payload = {
      id: 'request',
      grantId: grant.id,
      method: 'model.invoke',
      params: { profileId: 'local', value: 42 },
    };
    assert.equal(
      (await fetch(env.PART_BRIDGE_URL, { method: 'POST', body: JSON.stringify(payload) })).status,
      403,
    );
    assert.equal((await bridge.invoke(payload, owner)).kind, 'rejected');
    const authenticated = expectProperty(
      bridge.authenticate(grant.id, env.PART_BRIDGE_CREDENTIAL, env.PART_BRIDGE_AUDIENCE),
      'value',
    );
    assert.equal(
      (await bridge.invoke({ ...payload, params: { profileId: 'foreign' } }, authenticated)).kind,
      'rejected',
    );
    const source = `const env=process.env; const request=${JSON.stringify(payload)}; const result=await fetch(env.PART_BRIDGE_URL,{method:'POST',headers:{authorization:'Bearer '+env.PART_BRIDGE_CREDENTIAL,'x-part-bridge-audience':env.PART_BRIDGE_AUDIENCE},body:JSON.stringify(request)}); console.log(JSON.stringify(await result.json()));`;
    await writeFile(join(root, 'bridge.mjs'), source);
    const scripts = createNodeScripts({
      root,
      interpreters: { node: process.execPath },
      bridge: transport,
    });
    const handle = expectProperty(
      await scripts.execute(
        {
          requestId: 'script',
          executorId: 'part/node-process',
          source: {
            relativePath: 'bridge.mjs',
            digest: await digest(new TextEncoder().encode(source)),
          },
          interpreter: 'node',
          args: [],
          bridgeGrant: grant.id,
          capture: { kind: 'stdout-json', maxBytes: 2048 },
          effects: 'read',
          retry: 'never',
        },
        owner,
      ),
      'value',
    );
    const outcome = await handle.done;
    assert.equal(outcome.phase, 'completed');
    assert.equal(
      expectProperty(
        expectProperty(expectProperty(outcome.result.captured, 'value'), 'result'),
        'value',
      ),
      42,
    );
    assert.equal((await bridge.invoke(payload, authenticated)).kind, 'completed');
    assert.equal(calls, 1);
    assert.equal(
      (
        await bridge.invoke(
          { ...payload, params: { profileId: 'local', value: 43 } },
          authenticated,
        )
      ).kind,
      'rejected',
    );
    assert.equal((await bridge.invoke({ ...payload, id: 'next' }, authenticated)).kind, 'rejected');
    assert.equal(calls, 2);
    await bridge.revoke(grant.id, owner);
    assert.equal(
      bridge.authenticate(grant.id, env.PART_BRIDGE_CREDENTIAL, env.PART_BRIDGE_AUDIENCE).ok,
      false,
    );
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Script tools share one prepared executor attempt; direct workflow scripts retain their own boundary', async () => {
  const { createToolDispatcher, installTool } = await import('@slop-lab/part/tools.js');
  const { schema } = await import('@slop-lab/part/contracts/index.js');
  const { isScriptRequest } = await import('@slop-lab/part/scripts/index.js');
  const { createBoundary } = await import('@slop-lab/part/runtime/index.js');
  const root = await mkdtemp(join(tmpdir(), 'part-script-attempt-'));
  try {
    const source = 'console.log(JSON.stringify({done:true}));';
    await writeFile(join(root, 'source.cjs'), source);
    let prepares = 0,
      settles = 0;
    const boundary = createBoundary({
      prepare: async () => {
        prepares++;
        return ok(undefined);
      },
      settle: async () => {
        settles++;
        return ok([]);
      },
    });
    const scripts = createNodeScripts({
      root,
      interpreters: { node: process.execPath },
      boundary,
    });
    /** @type {import('@slop-lab/part/reference/index.js').Scripts.Request} */
    const request = {
      requestId: 'one',
      executorId: 'part/node-process',
      source: {
        relativePath: 'source.cjs',
        digest: await digest(new TextEncoder().encode(source)),
      },
      interpreter: 'node',
      args: [],
      capture: { kind: 'stdout-json', maxBytes: 1024 },
      effects: 'read',
      retry: 'never',
    };
    const executor = scripts.executor();
    const tool = installTool({
      definition: {
        id: 'test/script',
        version: '1',
        description: 'Explicit script',
        input: schema('test/script-request', isScriptRequest),
        output: jsonSchema,
        executor: executor.id,
        effects: 'read',
        cancellation: 'cooperative',
        retrySafety: 'never',
        requiredCapabilities: [],
      },
      execute: async () => {
        throw Error('External executor must own the process');
      },
    });
    const dispatcher = expectProperty(
      createToolDispatcher({
        tools: [tool],
        executors: [executor],
        boundary,
      }),
      'value',
    );
    const budget = createBudget({ maxExecutorAttempts: 1 });
    const caller = localContext({
      services: singleService(budgetKey, budget),
    });
    const handle = expectProperty(
      await dispatcher.dispatch(
        { logicalCallId: 'one', toolId: tool.id, arguments: request },
        caller,
      ),
      'value',
    );
    assert.equal((await handle.done).phase, 'completed');
    assert.equal(prepares, 1);
    assert.equal(settles, 1);
    const second = expectProperty(
      await dispatcher.dispatch(
        { logicalCallId: 'two', toolId: tool.id, arguments: request },
        caller,
      ),
      'value',
    );
    assert.equal((await second.done).phase, 'failed');
    const direct = expectProperty(
      await scripts.execute({ ...request, requestId: 'direct' }, context),
      'value',
    );
    assert.equal((await direct.done).phase, 'completed');
    assert.equal(prepares, 3);
    assert.equal(settles, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Processor timeout rejects acceptance and late normalization cannot revive the submission', async () => {
  const { createOperations } = await import('@slop-lab/part/runtime/index.js');
  const gate = deferred();
  /** @type {import('@slop-lab/part/reference/index.js').Results.Processor} */
  const processor = {
    id: 'test/timeout',
    version: '1',
    inputType: jsonSchema.ref,
    outputType: jsonSchema.ref,
    process: async (input) => {
      await gate.promise;
      return ok({
        output: input,
        evidence: {
          validator: 'test/timeout',
          version: '1',
          status: 'pass',
          inputDigest: await digest(expectProperty(input, 'value')),
          outputDigest: await digest(expectProperty(input, 'value')),
          diagnostics: [],
        },
      });
    },
  };
  const results = expectProperty(
    createResults(
      [{ id: jsonSchema.ref.id, version: 1, schema: jsonSchema, mediaType: 'application/json' }],
      {
        processors: [processor],
        profiles: { normalize: [processor.id] },
        processorTimeoutMs: 5,
        operations: createOperations({ cancellationGraceMs: 5 }),
      },
    ),
    'value',
  );
  /** @type {import('@slop-lab/part/reference/index.js').Results.Submission} */
  const request = {
    submissionId: 'one',
    expectedType: jsonSchema.ref,
    data: { kind: 'inline', value: {} },
    producedBy: { owner: 'test', kind: 'run', id: 'one' },
    validationProfile: 'normalize',
  };
  const failed = await results.submit(request, context);
  assert.equal(failed.ok, false);
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal((await results.submit(request, context)).ok, false);
});
