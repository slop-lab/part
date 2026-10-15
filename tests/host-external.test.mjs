// @ts-check
import { createExternalEngine } from '@slop-lab/part-plugins/workflows/external.js';
import { createPlanner } from '@slop-lab/part/composition/index.js';
import { provenance } from '@slop-lab/part/context/index.js';
import { fail, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createResourceManager } from '@slop-lab/part/host/resources.js';
import { createRuntimeHost } from '@slop-lab/part/host/runtime.js';
import { createOperations } from '@slop-lab/part/runtime/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, present, stub } from '../fixtures/assertions.mjs';
const context = localContext();
const delay = /** @param {number} ms */ (ms) => new Promise((r) => setTimeout(r, ms));
/** @template T @param {T} result @returns {import('@slop-lab/part/reference/index.js').Runtime.ManagedOutcome<T>} */
const terminal = (result) => ({
  phase: 'completed',
  result,
  effect: 'not-applied',
  commit: [],
  unsettledChildren: [],
});
test('Resource ownership transfer and cleanup preserve failed resources for reconciliation', async () => {
  const resources = createResourceManager({ closeGraceMs: 5 });
  const a = { kind: 'runtime', id: 'a' },
    b = { kind: 'runtime', id: 'b' };
  let closed = 0;
  const ref = { owner: 'test', kind: 'socket', id: 'one' };
  assert.equal(
    resources.register({
      ref,
      owner: a,
      transferable: true,
      close: async () => {
        closed++;
        return ok(undefined);
      },
    }).ok,
    true,
  );
  assert.equal(resources.transfer(ref, b).ok, true);
  assert.equal((await resources.closeOwner(a)).released.length, 0);
  assert.equal((await resources.closeOwner(b)).released.length, 1);
  assert.equal(closed, 1);
  resources.register({
    ref,
    owner: a,
    transferable: false,
    close: async () => fail('test.close', 'Close failed'),
  });
  assert.equal(resources.transfer(ref, b).ok, false);
  assert.equal((await resources.closeOwner(a)).unresolved.length, 1);
  assert.equal((await resources.closeOwner(a)).unresolved.length, 1);
});
test('Runtime admission enforces capacity, replacement, dedupe, expiry and drain; unknown cleanup stays unresolved', async () => {
  const operations = createOperations({ cancellationGraceMs: 5 });
  /** @type {unknown[]} */
  const effects = [];
  /** @type {Map<unknown, () => void>} */
  const gates = new Map();
  /** @type {Pick<import("@slop-lab/part/reference/index.js").Runtime.RunService, "start">} */
  const runs = {
    async start(request, context) {
      return operations.begin(
        { kind: 'part/run', childPolicy: 'attached', retryOwner: 'test' },
        async (c) => {
          effects.push(request.input);
          await new Promise((resolve) => {
            gates.set(request.input, () => resolve(undefined));
            c.signal.addEventListener('abort', () => resolve(undefined), { once: true });
          });
          return terminal(request.input);
        },
        context,
      );
    },
  };
  const host = createRuntimeHost({
    runs: stub(runs),
    maxConcurrent: 1,
    maxQueued: 2,
    policy: {
      decide(request, pending) {
        return ok({
          action: request.concurrencyKey === 'replace' ? 'replace-pending' : 'queue',
          affected:
            request.concurrencyKey === 'replace'
              ? pending.filter((p) => p.concurrencyKey === 'replace').map((p) => p.requestId)
              : [],
        });
      },
    },
  });
  await host.start(context);
  const composition = expectProperty(
    createPlanner().resolve({ components: [], config: {} }),
    'value',
  );
  /** @param {string} id @param {Partial<import("@slop-lab/part/reference/index.js").Host.AdmissionRequest>} extra */
  const request = (id, extra = {}) => ({
    requestId: id,
    run: { driver: 'test', composition, input: id },
    ...extra,
  });
  await host.submit(request('one'), context);
  await delay(2);
  assert.equal(expectProperty(host.getJob('one', context), 'value').kind, 'started');
  await host.submit(request('old', { concurrencyKey: 'replace' }), context);
  await host.submit(request('new', { concurrencyKey: 'replace' }), context);
  assert.equal(expectProperty(host.getJob('old', context), 'value').kind, 'superseded');
  assert.equal(
    expectProperty(
      await host.submit(request('new', { concurrencyKey: 'replace' }), context),
      'value',
    ).kind,
    'queued',
  );
  assert.equal(
    (
      await host.submit(
        { ...request('new'), run: { driver: 'test', composition, input: 'changed' } },
        context,
      )
    ).ok,
    false,
  );
  await host.submit(
    request('expired', { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    context,
  );
  present(gates.get('one'))();
  await delay(5);
  assert.deepEqual(effects, ['one', 'new']);
  present(gates.get('new'))();
  const report = await host.stop({
    mode: 'drain',
    deadline: new Date(Date.now() + 1000).toISOString(),
  });
  assert.equal(report.unresolved.length, 0);
  assert.equal(expectProperty(host.getJob('expired', context), 'value').kind, 'rejected');
  assert.equal((await host.submit(request('later'), context)).ok, false);
  const unknown = createRuntimeHost({
    runs: stub({
      start: (_request, c) =>
        operations.begin(
          { kind: 'part/run', childPolicy: 'attached', retryOwner: 'test' },
          async () => new Promise(() => {}),
          c,
        ),
    }),
  });
  await unknown.start(context);
  await unknown.submit(request('uncooperative'), context);
  await delay(1);
  assert.equal(
    (await unknown.stop({ mode: 'cancel', deadline: new Date(Date.now() + 1000).toISOString() }))
      .unresolved.length,
    1,
  );
});
test('External adapter attaches native owner state after unknown submission and forwards actions without second scheduling', async () => {
  let submits = 0,
    actions = 0;
  /** @type {Map<import('@slop-lab/part/reference/index.js').Contracts.Json | undefined, Omit<import('@slop-lab/part/reference/index.js').Workflows.Snapshot, 'ref'>>} */
  const records = new Map();
  /** @type {Map<string, import('@slop-lab/part/reference/index.js').Contracts.Json>} */
  const keys = new Map();
  /** @type {import('@slop-lab/part/reference/index.js').Workflows.EngineDescriptor} */
  const descriptor = {
    id: 'test/native',
    version: '1',
    forms: ['external'],
    formats: [{ id: 'native', versions: ['1'] }],
    capabilities: { revision: '1', entries: [] },
  };
  /** @type {import('@slop-lab/part/reference/index.js').Workflows.Guarantees} */
  const guarantees = {
    control: 'runner-enforced',
    effects: 'runner-path-only',
    checkpoint: 'engine-native',
    submissionDedupe: 'durable',
    scriptCancellation: 'engine-native',
    nativeSemantics: [
      'Native owner schedules continuation',
      'Inner agent effects are not checkpointed',
    ],
  };
  /** @type {Parameters<typeof createExternalEngine>[1]} */
  const port = {
    prepare: async () =>
      ok({
        compositionRevision: 'native1',
        input: jsonSchema.ref,
        output: jsonSchema.ref,
        guarantees,
        compatibility: {
          format: 'native',
          sourceVersion: '1',
          adapter: 'test',
          adapterVersion: '1',
          status: /** @type {const} */ ('exact-tested-subset'),
          ignored: [],
          semantics: [],
        },
        report: [],
        localHandle: { code: 'installed' },
      }),
    async submit(key, _prepared, input) {
      submits++;

      const native = { job: 'one' };
      keys.set(key, native);
      records.set(expectProperty(native, 'job'), {
        revision: 'native/1',
        definitionDigest: 'native-digest',
        owner: 'native-owner',
        phase: 'waiting',
        nativeState: { schema: jsonSchema.ref, data: { cursor: 'native-node-3', input } },
        guarantees,
        activeOperations: [],
        waitingOn: [],
        diagnostics: [],
        actions: [
          {
            id: 'native/approve',
            version: 1,
            input: jsonSchema.ref,
            output: jsonSchema.ref,
            execution: 'immediate',
            availability: { state: 'available', checkedAt: 'native/1' },
          },
        ],
        effect: 'unknown',
      });
      return {
        kind: 'unknown',
        reconciliationKey: key,
        error: fail('test.network', 'Delivery interrupted', 'unavailable', 'unknown').error,
      };
    },
    get: async (native) =>
      records.has(expectProperty(native, 'job'))
        ? ok(present(records.get(expectProperty(native, 'job'))))
        : fail('native.missing', 'Unknown native job'),
    cancel: async (native) => {
      const entry = present(records.get(expectProperty(native, 'job')));
      records.set(expectProperty(native, 'job'), { ...entry, phase: 'cancelled' });
      return ok({
        state: 'confirmed',
        effect: /** @type {const} */ ('unknown'),
        unresolvedTargets: [],
      });
    },
    observe: () => ({ async *[Symbol.asyncIterator]() {} }),
    action: async (native, command) => {
      actions++;
      const record = present(records.get(expectProperty(native, 'job')));
      records.set(expectProperty(native, 'job'), {
        ...record,
        phase: 'succeeded',
        output: {
          kind: 'native',
          data: { done: true },
          validation: 'unverified',
          provenance,
        },
      });
      return {
        kind: 'completed',
        commandId: command.commandId,
        result: { done: true },
        effect: 'applied',
        commit: [],
      };
    },
    reconcile: async (key) => ok(keys.get(key) ?? null),
  };
  const engine = createExternalEngine(descriptor, port);
  const prepared = expectProperty(
    await engine.prepare(
      {
        engineId: descriptor.id,
        definition: {
          id: 'job',
          digest: 'native-digest',
          format: 'native',
          formatVersion: '1',
          source: { owner: 'native', native: {} },
        },
        profileId: 'default',
        requiredCapabilities: [],
        requiredControl: 'runner-enforced',
      },
      context,
    ),
    'value',
  );
  const request = { requestId: 'one', idempotencyKey: 'stable', prepared, input: { task: 1 } };
  const [one, two] = await Promise.all([
    engine.start(request, context),
    engine.start(request, context),
  ]);
  assert.equal(one.kind, 'unknown');
  assert.equal(expectProperty(two, 'reconciliationKey'), one.reconciliationKey);
  assert.equal(submits, 1);
  const attached = expectProperty(
    await present(engine.reconcileSubmission)(one.reconciliationKey, context),
    'value',
  );
  assert.ok(attached);
  const snapshot = expectProperty(await engine.get(attached, context), 'value');
  assert.equal(expectProperty(snapshot.nativeState.data, 'cursor'), 'native-node-3');
  assert.equal(snapshot.guarantees.checkpoint, 'engine-native');
  assert.equal((await engine.get({ ...attached, native: { job: 'other' } }, context)).ok, false);
  assert.equal(
    (
      await present(engine.reconcileSubmission)(
        one.reconciliationKey,
        localContext({ principal: { subject: 'foreign', authority: 'test' } }),
      )
    ).ok,
    false,
  );
  await engine.action(
    attached,
    {
      commandId: 'approve',
      actionId: 'native/approve',
      actionVersion: 1,
      protocolVersion: 1,
      input: true,
    },
    context,
  );
  assert.equal(expectProperty(await engine.get(attached, context), 'value').phase, 'succeeded');
  assert.equal(actions, 1);
  assert.equal(submits, 1);
  assert.equal((await engine.start({ ...request, input: { task: 2 } }, context)).kind, 'rejected');
});
