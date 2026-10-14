import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../dist/storage-memory.js';
import { openSqliteStore } from '../dist/storage-sqlite.js';
import { createHistory } from '../dist/history.js';
import { createStoredBoundary, createExecutionRecovery } from '../dist/storage-runtime.js';
import { localContext } from '../dist/contracts.js';
import { provenance } from '../dist/context.js';
import { managedAttempt } from '../dist/runtime.js';
const context = localContext();
const address = { namespace: 'test', scope: { kind: 'runtime', id: 'r' }, key: 'state' };
const change = (id, expected = 'absent', value = 1) => ({
  id,
  mutations: [{ address, expected, next: { schemaVersion: 1, value } }],
  append: [{ id, type: 'test', version: 1, payload: value, provenance }],
});
for (const kind of ['memory', 'sqlite'])
  test(`DU01/DU02: ${kind} commits state+journal atomically and preserves CAS/dedupe`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'part-storage-'));
    const store =
      kind === 'memory' ? createMemoryStore() : openSqliteStore(join(dir, 'state.sqlite')).value;
    try {
      const committed = await store.commit(change('first'), context);
      assert.equal(committed.ok, true);
      assert.deepEqual((await store.commit(change('first'), context)).value, committed.value);
      assert.equal((await store.commit(change('first', 'absent', 2), context)).ok, false);
      assert.equal((await store.commit(change('conflict'), context)).ok, false);
      assert.equal((await store.read(address, context)).value.value.value, 1);
      assert.equal((await store.journal(undefined, 100, context)).value.items.length, 1);
      const revision = (await store.read(address, context)).value.revision;
      const raced = await Promise.all([
        store.commit(change('a', revision, 2), context),
        store.commit(change('b', revision, 3), context),
      ]);
      assert.equal(raced.filter((r) => r.ok).length, 1);
      if (kind === 'sqlite') {
        store.close();
        const reopened = openSqliteStore(join(dir, 'state.sqlite')).value;
        assert.equal((await reopened.journal(undefined, 100, context)).value.items.length, 2);
        assert.equal((await reopened.read(address, context)).value.value.value, 2);
        reopened.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
test('G06: immutable history, stale append rejection and forks preserve source paths', async () => {
  const history = createHistory(),
    session = (await history.createSession({}, context)).value;
  const branch = (await history.getBranch(session.id, context)).value;
  const record = {
    id: 'r1',
    type: 'text',
    schemaVersion: 1,
    payload: { text: 'original' },
    provenance,
    createdAt: new Date().toISOString(),
    visibility: { model: true, conversation: true, inspector: false, export: true },
  };
  const appended = await history.append(branch, [record], context);
  assert.equal(appended.ok, true);
  record.payload.text = 'mutated';
  assert.equal(
    (await history.path(appended.value, undefined, context)).value.items[0].record.payload.text,
    'original',
  );
  assert.equal((await history.append(branch, [], context)).ok, false);
  const fork = await history.fork(appended.value, appended.value.head, context);
  assert.equal((await history.path(fork.value, undefined, context)).value.items.length, 1);
  assert.equal(
    (
      await history.getBranch(
        branch.id,
        localContext({ principal: { subject: 'other', authority: 'local' } }),
      )
    ).ok,
    false,
  );
});
test('DU04/G11: committed intents recover as unknown/abandoned without repeating effects', async () => {
  const store = createMemoryStore(),
    boundary = createStoredBoundary(store),
    plan = {
      operationId: 'o',
      attemptId: 'a',
      target: 't',
      executor: 'e',
      inputDigest: 'i',
      scopeDigest: 's',
      compositionRevision: 'r',
      classification: 'write',
    };
  await boundary.prepare(plan, context); // Simulated crash after intent and before settle/publication.
  const recovery = await createExecutionRecovery(store).recover(context);
  assert.equal(recovery.value.abandoned.length, 1);
  assert.equal(recovery.value.reconciliationRequired.length, 1);
  const persisted = await store.read(
    { namespace: 'part/execution', scope: { kind: 'operation', id: 'o' }, key: 'a' },
    context,
  );
  assert.equal(persisted.value.value.value.effect, 'unknown');
  let count = 0;
  const completed = await managedAttempt(
    boundary,
    { ...plan, attemptId: 'b' },
    async () => {
      count++;
      return { kind: 'returned', value: 42, effect: 'applied' };
    },
    context,
  );
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.commit[0].durability, 'memory');
  assert.equal(count, 1);
  store.close();
});
