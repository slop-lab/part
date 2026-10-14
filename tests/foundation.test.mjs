import test from 'node:test';
import assert from 'node:assert/strict';
import { localContext, ok, fail, jsonSchema, stringSchema, canonical } from '../dist/contracts.js';
import { createPlanner, createScopeManager } from '../dist/composition.js';
import { createOperations, createBoundary, managedAttempt, createBudget, createProgress } from '../dist/runtime.js';
import { createSuspensions } from '../dist/waits.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const completed = result => ({ phase: 'completed', result, effect: 'not-applied', unsettledChildren: [], commit: [] });
const spec = { kind: 'test', retryOwner: 'test', childPolicy: 'attached' };
const context = localContext();
const plan = { operationId: 'o', attemptId: 'a', target: 'tool', executor: 'function', inputDigest: 'i', scopeDigest: 's', compositionRevision: 'r', classification: 'write' };
const point = { id: 'test/registry', owner: 'test', contractVersion: 1, kind: 'registry', scope: 'runtime' };
const component = (id, register, requires = [], provides = [], lifecycle = {}) => ({ descriptor: { id, version: '1', scope: 'runtime', surfaces: ['test'], requires, provides }, register,
  create: () => ok({ initialize: async () => ok(), start: async () => ok(), stop: async () => ({ released: [], unresolved: [], errors: [] }), dispose: async () => ({ released: [], unresolved: [], errors: [] }), ...lifecycle }) });

test('X08: codecs reject lossy wire values, sparse arrays, custom array properties, and cycles', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const custom = []; custom.secret = 'lost';
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), { a: undefined }, [ , 1], custom, cyclic, new AbortController().signal]) assert.equal(jsonSchema.codec.encode(value).ok, false);
  const data = { z: [1, null], a: true }; assert.deepEqual(jsonSchema.codec.decode(data).value, data);
  assert.equal(canonical(data), '{"a":true,"z":[1,null]}');
});
test('C03-C05: missing dependencies, duplicate keys, replacement, deterministic ordering and cycles', () => {
  const planner = createPlanner();
  assert.equal(planner.resolve({ components: [component('a', () => ok(), [{ id: 'missing', contractVersion: 1, optional: false }])], config: {} }).ok, false);
  const register = r => { r.declare(point); r.contribute({ id: 'z', point: { ...point }, key: 'z', value: 1 }); r.contribute({ id: 'a', point, key: 'a', value: 2, after: ['z'] }); return ok(); };
  const resolved = planner.resolve({ components: [component('a', register)], config: {} }); assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.value.inspection.orderedBindings[0].contributions, ['z', 'a']);
  assert.equal(planner.resolve({ components: [component('a', register)], config: {}, edits: [r => r.contribute({ id: 'dup', point, key: 'z', value: 3 })] }).ok, false);
  assert.equal(planner.resolve({ components: [component('a', register)], config: {}, edits: [r => r.replace({ point, replaces: 'z', with: { id: 'z', point, key: 'z', value: 9 } })] }).ok, true);
  assert.equal(planner.resolve({ components: [component('a', register)], config: {}, edits: [r => r.replace({ point, replaces: 'absent', with: { id: 'x', point, key: 'x', value: 9 } })] }).ok, false);
  assert.equal(planner.resolve({ components: [component('a', register)], config: {}, edits: [r => r.replace({ point, replaces: 'z', with: { id: 'z', point, key: 'z', value: 9, after: ['a'] } })] }).ok, false);
});
test('C06: initialization failure disposes created modules in reverse order', async () => {
  const log = [], cleanup = id => async () => { log.push(id); return { released: [], unresolved: [], errors: [] }; };
  const components = ['a','b','c'].map(id => component(id, () => ok(), [], [], { initialize: async () => id === 'c' ? fail('fixture', 'Failure') : ok(), stop: cleanup(`stop-${id}`), dispose: cleanup(`dispose-${id}`) }));
  const composition = createPlanner().resolve({ components, config: {} }).value;
  const opened = await createScopeManager().open({ kind: 'runtime', id: 'r' }, composition);
  assert.equal(opened.ok, false); assert.deepEqual(log, ['dispose-c', 'stop-b', 'dispose-b', 'stop-a', 'dispose-a']);
});
test('E01-E02: execution proceeds without subscribers and closing observation does not cancel', async () => {
  const operations = createOperations(); let count = 0;
  const created = await operations.begin(spec, async c => { await delay(10); count++; return completed(42); }, context);
  const iterator = created.value.observe()[Symbol.asyncIterator](); await iterator.return();
  assert.equal((await created.value.done).result, 42); assert.equal(count, 1); assert.equal(created.value.snapshot().cancel.state, 'not-requested');
});
test('E04/E09: unacknowledged cancellation remains abandoned when late results arrive', async () => {
  const operations = createOperations({ cancellationGraceMs: 5 }); let release;
  const created = await operations.begin(spec, () => new Promise(resolve => { release = resolve; }), context);
  await delay(0); await created.value.requestCancel('test');
  assert.equal((await created.value.done).phase, 'abandoned'); assert.equal(created.value.snapshot().cancel.state, 'partial');
  release(completed(1)); await delay(0); assert.equal(created.value.snapshot().phase, 'abandoned');
});
test('E06: successful parents cannot leave uncooperative attached children', async () => {
  const operations = createOperations({ cancellationGraceMs: 5 });
  const parent = await operations.begin(spec, async c => {
    await operations.begin({ ...spec, parent: { owner: 'part/operations', kind: 'test', id: c.scope.id } }, () => new Promise(() => {}), c);
    await delay(0); return completed('parent');
  }, context);
  assert.equal((await parent.value.done).phase, 'abandoned'); assert.equal((await parent.value.done).unsettledChildren.length, 1);
});
test('E07/E08/E10: prepare blocks execution and settle failure preserves applied effects', async () => {
  let count = 0, release;
  const boundary = createBoundary({ prepare: () => new Promise(resolve => { release = resolve; }), settle: async () => fail('storage', 'Disk failed', 'internal') });
  const pending = managedAttempt(boundary, plan, async () => { count++; return { kind: 'returned', value: 1, effect: 'applied' }; }, context);
  await delay(0); assert.equal(count, 0); release(ok());
  const result = await pending; assert.equal(count, 1); assert.equal(result.phase, 'failed'); assert.equal(result.effect, 'applied');
  const rejected = await managedAttempt(createBoundary({ prepare: async () => fail('denied', 'No', 'permission') }), plan, async () => { count++; return { kind: 'returned', value: 1, effect: 'applied' }; }, context);
  assert.equal(rejected.effect, 'not-attempted'); assert.equal(count, 1);
  assert.equal((await boundary.settle({ attemptId: 'a', planDigest: 'fake', boundary: 'part/boundary' }, { kind: 'returned', value: 1, effect: 'applied' }, context)).ok, false);
});
test('E05: synchronous budget reservations prevent oversubscription', () => {
  const budget = createBudget({ attempts: 1 }); const first = budget.reserve('attempts', 1); assert.equal(first.ok, true);
  assert.equal(budget.reserve('attempts', 1).ok, false); assert.equal(budget.settle(first.value, 0).ok, true); assert.equal(budget.settle(first.value, 0).ok, false);
  assert.equal(budget.reserve('attempts', 1).ok, true);
});
test('bounded observation signals gaps to slow consumers', async () => {
  const progress = createProgress(), iterator = progress.observe({ bufferSize: 2 })[Symbol.asyncIterator]();
  for (let i=0; i<8; i++) progress.publish('token', i);
  assert.equal((await iterator.next()).value.kind, 'gap'); assert.equal((await iterator.next()).value.payload, 7); progress.end(); assert.equal((await iterator.next()).done, true);
});
test('waits validate authority, revision, schema and deduplicate responses', async () => {
  const waits = createSuspensions(), ticket = (await waits.open({ type: 'question', responseSchema: stringSchema, presentation: {}, bindingDigest: 'fixed' }, context)).value;
  assert.equal((await waits.respond(ticket, 'yes', 'a', localContext({ principal: { subject: 'stranger', authority: 'local' } }))).ok, false);
  assert.equal((await waits.respond(ticket, 1, 'a', context)).ok, false);
  const pending = waits.wait(ticket, stringSchema, context); assert.equal((await waits.respond(ticket, 'yes', 'a', context)).ok, true); assert.equal((await pending).value, 'yes');
  assert.equal((await waits.respond(ticket, 'yes', 'a', context)).ok, true); assert.equal((await waits.respond(ticket, 'no', 'a', context)).ok, false); assert.equal((await waits.respond(ticket, 'yes', 'b', context)).ok, false);
});
