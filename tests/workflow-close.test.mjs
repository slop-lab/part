// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createWorkflowEndpoint } from '@slop-lab/part-plugins/workflows/endpoint.js';
import { createWorkflowHost } from '@slop-lab/part-plugins/workflows/host.js';

const context = localContext();
/** @type {import('@slop-lab/part/reference/index.js').Workflows.DefinitionRef} */
const definition = {
  id: 'test',
  format: 'test',
  formatVersion: '1',
  digest: 'digest',
  source: { owner: 'test', native: {} },
};
/** @type {import('@slop-lab/part/reference/index.js').Workflows.EngineDescriptor} */
const descriptor = {
  id: 'test/engine',
  version: '1',
  forms: ['custom'],
  formats: [{ id: 'test', versions: ['1'] }],
  capabilities: { revision: '1', entries: [] },
};
/** @type {import('@slop-lab/part/reference/index.js').Workflows.Guarantees} */
const guarantees = {
  control: 'runner-enforced',
  effects: 'runner-path-only',
  checkpoint: 'none',
  submissionDedupe: 'memory',
  scriptCancellation: 'cooperative',
  nativeSemantics: [],
};

/** @param {{limits?: import('@slop-lab/part/reference/index.js').Runtime.ExecutionLimits,
 * cancellationDrainMs?: number, project?: Parameters<typeof createWorkflowEndpoint>[0]['project'],
 * mirror?: Parameters<typeof createWorkflowEndpoint>[0]['mirror'], cancelThrows?: boolean, cancelHangs?: boolean}} [options] */
function fixture(options = {}) {
  const ref = { engine: descriptor.id, engineVersion: descriptor.version, id: 'execution' };
  /** @type {'running'|'cancelled'} */
  let phase = 'running';
  /** @type {import('@slop-lab/part/reference/index.js').Runtime.Update[]} */
  const updates = [];
  /** @type {(() => void)[]} */
  const readers = [];
  /** @type {import('@slop-lab/part/reference/index.js').Workflows.StartRequest[]} */
  const starts = [];
  let prepares = 0;
  /** @returns {import('@slop-lab/part/reference/index.js').Workflows.Snapshot} */
  const snapshot = () => ({
    ref,
    revision: phase,
    definitionDigest: definition.digest,
    owner: descriptor.id,
    phase,
    nativeState: { schema: { id: 'test', version: 1 }, data: {} },
    guarantees,
    activeOperations: phase === 'running' ? [{ owner: 'test', kind: 'script', id: 'child' }] : [],
    waitingOn: [],
    diagnostics: [],
    actions: [],
    effect: 'not-applicable',
  });
  /** @type {import('@slop-lab/part/reference/index.js').Workflows.Engine} */
  const engine = {
    descriptor,
    async prepare() {
      prepares++;
      return ok({
        definition,
        engine: descriptor,
        compositionRevision: '1',
        input: { id: 'part/json', version: 1 },
        output: { id: 'part/json', version: 1 },
        guarantees,
        compatibility: {
          format: 'test',
          sourceVersion: '1',
          adapter: descriptor.id,
          adapterVersion: '1',
          status: 'exact-tested-subset',
          ignored: [],
          semantics: [],
        },
        report: [],
        localHandle: {},
      });
    },
    async start(request) {
      starts.push(request);
      return { kind: 'accepted', ref, snapshot: snapshot() };
    },
    async get() {
      return ok(snapshot());
    },
    async requestCancel() {
      if (options.cancelThrows) throw new Error('injected adapter failure');
      if (options.cancelHangs) await new Promise(() => {});
      return ok({ state: 'requested', unresolvedTargets: [] });
    },
    observe(_ref, observed) {
      return {
        async *[Symbol.asyncIterator]() {
          while (!observed.signal.aborted) {
            if (!updates.length)
              await new Promise((resolve) => {
                readers.push(() => resolve(undefined));
                observed.signal.addEventListener('abort', () => resolve(undefined), { once: true });
              });
            if (observed.signal.aborted) return;
            const update = updates.shift();
            if (update) yield update;
          }
        },
      };
    },
    async action(_ref, command) {
      return {
        kind: 'completed',
        commandId: command.commandId,
        result: null,
        effect: 'not-applicable',
        commit: [],
      };
    },
  };
  const hosted = createWorkflowHost([engine]);
  assert.ok(hosted.ok);
  const host = hosted.value;
  const created = createWorkflowEndpoint({
    host,
    registrations: [{ definition, engineId: descriptor.id, profileIds: ['default'] }],
    composition: { id: 'test', revision: '1' },
    context,
    ...options,
  });
  assert.ok(created.ok);
  return {
    endpoint: created.value,
    starts,
    prepares: () => prepares,
    cancel() {
      phase = 'cancelled';
      updates.push({ kind: 'data', index: 1, type: 'cancelled', payload: null });
      for (const read of readers.splice(0)) read();
    },
  };
}

/** @param {string} commandId @param {import('@slop-lab/part/reference/index.js').Contracts.Json} [limits]
 * @returns {import('@slop-lab/part/reference/index.js').Contracts.CommandRequest} */
function start(commandId, limits) {
  return {
    protocolVersion: 1,
    commandId,
    actionId: 'part.workflow/start',
    actionVersion: 1,
    input: {
      engineId: descriptor.id,
      definition: { id: definition.id, digest: definition.digest },
      profileId: 'default',
      composition: { id: 'test', revision: '1' },
      input: {},
      requiredControl: 'runner-enforced',
      requiredCapabilities: [],
      ...(limits === undefined ? {} : { limits }),
    },
  };
}

test('workflow close keeps observations live until cancellation reaches terminal state', async () => {
  // Given
  const setup = fixture({ cancellationDrainMs: 1_000 });
  assert.equal((await setup.endpoint.command(start('start'), context)).kind, 'accepted');

  // When
  const closing = setup.endpoint.close();
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Then
  assert.equal(settled, false);
  setup.cancel();
  const report = await closing;
  assert.deepEqual(report.unresolved, []);
  assert.equal(report.released.length, 1);
  assert.deepEqual(await setup.endpoint.close(), report);
});

test('workflow close bounds throwing and unresponsive adapter cleanup and retains unresolved ownership', async () => {
  for (const failure of [{ cancelThrows: true }, { cancelHangs: true }]) {
    const setup = fixture({ ...failure, cancellationDrainMs: 20 });
    assert.equal((await setup.endpoint.command(start('start'), context)).kind, 'accepted');
    const report = await setup.endpoint.close();
    assert.equal(report.unresolved.length, 1);
    assert.equal(report.errors.length, 1);
    assert.deepEqual(await setup.endpoint.close(), report);
  }
});

test('workflow endpoint applies host ceilings when client limits are omitted, looser, or stricter', async () => {
  // Given
  const setup = fixture({ limits: { maxExecutorAttempts: 10, maxChildRuns: 4 } });

  // When
  await setup.endpoint.command(start('omitted'), context);
  await setup.endpoint.command(start('loose', { maxExecutorAttempts: 20 }), context);
  await setup.endpoint.command(start('strict', { maxExecutorAttempts: 3 }), context);

  // Then
  assert.deepEqual(
    setup.starts.map((entry) => entry.limits),
    [
      { maxExecutorAttempts: 10, maxChildRuns: 4 },
      { maxExecutorAttempts: 10, maxChildRuns: 4 },
      { maxExecutorAttempts: 3, maxChildRuns: 4 },
    ],
  );
  setup.cancel();
  await setup.endpoint.close();
});

test('workflow endpoint rejects unknown or invalid limits before preparation', async () => {
  // Given
  const setup = fixture({ limits: { maxExecutorAttempts: 10 } });

  // When
  const unknown = await setup.endpoint.command(start('unknown', { uninstalled: 1 }), context);
  const invalid = await setup.endpoint.command(
    start('invalid', { maxExecutorAttempts: -1 }),
    context,
  );

  // Then
  assert.equal(unknown.kind, 'rejected');
  assert.equal(invalid.kind, 'rejected');
  assert.equal(setup.prepares(), 0);
  await setup.endpoint.close();
});

test('custom workflow projections receive baseline cancel and mirror the augmented item', async () => {
  // Given
  /** @type {import('@slop-lab/part/reference/index.js').Projection.Item[]} */
  const mirrored = [];
  const setup = fixture({
    async project(snapshot) {
      return ok({
        id: snapshot.ref.id,
        type: 'part/workflow',
        schemaVersion: 1,
        revision: snapshot.revision,
        source: { owner: snapshot.ref.engine, kind: 'part/workflow', id: snapshot.ref.id },
        payload: {},
        fallback: { label: 'Custom', text: snapshot.phase },
        actions: [],
        artifacts: [],
      });
    },
    mirror: (item) => mirrored.push(item),
  });

  // When
  await setup.endpoint.command(start('start'), context);

  // Then
  assert.ok(
    setup.endpoint.hub
      .snapshot()
      .items[0]?.actions.some((action) => action.id === 'part.workflow/cancel'),
  );
  assert.ok(mirrored[0]?.actions.some((action) => action.id === 'part.workflow/cancel'));
  setup.cancel();
  await setup.endpoint.close();
});
