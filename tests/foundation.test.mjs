// @ts-check
import { createPlanner } from '@slop-lab/part/composition/index.js';
import {
  canonical,
  fail,
  jsonSchema,
  localContext,
  ok,
  stringSchema,
} from '@slop-lab/part/contracts/index.js';
import {
  budgetKey,
  createBoundary,
  createBudget,
  createOperations,
  createProgress,
  managedAttempt,
} from '@slop-lab/part/runtime/index.js';
import { createSuspensions } from '@slop-lab/part/runtime/waits.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, expectProperty, present } from '../fixtures/assertions.mjs';
import { singleService } from '../fixtures/contracts.mjs';
const delay = /** @param {number} ms */ (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @template T @param {T} result @returns {import('@slop-lab/part/reference/index.js').Runtime.ManagedOutcome<T>} */
const completed = (result) => ({
  phase: 'completed',
  result,
  effect: 'not-applied',
  unsettledChildren: [],
  commit: [],
});
/** @type {import('@slop-lab/part/reference/index.js').Runtime.OperationSpec} */
const spec = { kind: 'test', retryOwner: 'test', childPolicy: 'attached' };
const context = localContext();
/** @type {import('@slop-lab/part/reference/index.js').Runtime.EffectPlan} */
const plan = {
  operationId: 'o',
  attemptId: 'a',
  target: 'tool',
  executor: 'function',
  inputDigest: 'i',
  scopeDigest: 's',
  compositionRevision: 'r',
  classification: 'write',
};

test('X08: codecs reject lossy wire values, sparse arrays, custom array properties, and cycles', () => {
  const codec = present(jsonSchema.codec);
  const cyclic = {};
  cyclic.self = cyclic;
  /** @type {unknown[]} */
  const custom = [];
  Object.assign(custom, { secret: 'lost' });
  for (const value of [
    undefined,
    NaN,
    Infinity,
    () => {},
    new Date(),
    { a: undefined },
    [, 1],
    custom,
    cyclic,
    new AbortController().signal,
  ])
    // @ts-expect-error Invalid JSON values must be rejected by the codec.
    assert.equal(codec.encode(value).ok, false);
  const data = { z: [1, null], a: true };
  assert.deepEqual(expectProperty(present(jsonSchema.codec).decode(data), 'value'), data);
  assert.equal(canonical(data), '{"a":true,"z":[1,null]}');
});

test('E01-E02: execution proceeds without subscribers and closing observation does not cancel', async () => {
  const operations = createOperations();
  let count = 0;
  const created = await operations.begin(
    spec,
    async () => {
      await delay(10);
      count++;
      return completed(42);
    },
    context,
  );
  const iterator = expectProperty(created, 'value').observe()[Symbol.asyncIterator]();
  assert.ok(iterator.return);
  await iterator.return();
  assert.equal(expectProperty(await expectProperty(created, 'value').done, 'result'), 42);
  assert.equal(count, 1);
  assert.equal(expectProperty(created, 'value').snapshot().cancel.state, 'not-requested');
});
test('E04/E09: unacknowledged cancellation remains abandoned when late results arrive', async () => {
  const operations = createOperations({ cancellationGraceMs: 5 });
  const gate =
    /** @type {PromiseWithResolvers<import("@slop-lab/part/reference/index.js").Runtime.ManagedOutcome<number>>} */ (
      deferred()
    );
  const created = await operations.begin(spec, () => gate.promise, context);
  await delay(0);
  await expectProperty(created, 'value').requestCancel('test');
  assert.equal((await expectProperty(created, 'value').done).phase, 'abandoned');
  assert.equal(expectProperty(created, 'value').snapshot().cancel.state, 'partial');
  gate.resolve(completed(1));
  await delay(0);
  assert.equal(expectProperty(created, 'value').snapshot().phase, 'abandoned');
});
test('E06: successful parents cannot leave uncooperative attached children', async () => {
  const operations = createOperations({ cancellationGraceMs: 5 });
  const parent = await operations.begin(
    spec,
    async (c) => {
      await operations.begin(
        { ...spec, parent: { owner: 'part/operations', kind: 'test', id: c.scope.id } },
        () => new Promise(() => {}),
        c,
      );
      await delay(0);
      return completed('parent');
    },
    context,
  );
  assert.equal((await expectProperty(parent, 'value').done).phase, 'abandoned');
  assert.equal((await expectProperty(parent, 'value').done).unsettledChildren.length, 1);
});
test('E07/E08/E10: prepare blocks execution and settle failure preserves applied effects', async () => {
  let count = 0;
  const gate =
    /** @type {PromiseWithResolvers<import("@slop-lab/part/reference/index.js").Contracts.Result<void>>} */ (
      deferred()
    );
  const boundary = createBoundary({
    prepare: () => gate.promise,
    settle: async () => fail('storage', 'Disk failed', 'internal'),
  });
  const pending = managedAttempt(
    boundary,
    plan,
    async () => {
      count++;
      return { kind: 'returned', value: 1, effect: 'applied' };
    },
    context,
  );
  await delay(0);
  assert.equal(count, 0);
  gate.resolve(ok(undefined));
  const result = await pending;
  assert.equal(count, 1);
  assert.equal(result.phase, 'failed');
  assert.equal(result.effect, 'applied');
  const rejected = await managedAttempt(
    createBoundary({ prepare: async () => fail('denied', 'No', 'permission') }),
    plan,
    async () => {
      count++;
      return { kind: 'returned', value: 1, effect: 'applied' };
    },
    context,
  );
  assert.equal(rejected.effect, 'not-attempted');
  assert.equal(count, 1);
  assert.equal(
    (
      await boundary.settle(
        { attemptId: 'a', planDigest: 'fake', boundary: 'part/boundary' },
        { kind: 'returned', value: 1, effect: 'applied' },
        context,
      )
    ).ok,
    false,
  );
});
test('E05: synchronous budget reservations prevent oversubscription', () => {
  const budget = createBudget({ attempts: 1 });
  const first = budget.reserve('attempts', 1);
  assert.equal(first.ok, true);
  assert.equal(budget.reserve('attempts', 1).ok, false);
  assert.equal(budget.settle(first.value, 0).ok, true);
  assert.equal(budget.settle(first.value, 0).ok, false);
  assert.equal(budget.reserve('attempts', 1).ok, true);
});
test('bounded observation signals gaps to slow consumers', async () => {
  const progress = createProgress(),
    iterator = progress.observe({ bufferSize: 2 })[Symbol.asyncIterator]();
  for (let i = 0; i < 8; i++) progress.publish('token', i);
  assert.equal((await iterator.next()).value.kind, 'gap');
  assert.equal((await iterator.next()).value.payload, 7);
  progress.end();
  assert.equal((await iterator.next()).done, true);
});
test('waits validate authority, revision, schema and deduplicate responses', async () => {
  const waits = createSuspensions(),
    ticket = expectProperty(
      await waits.open(
        {
          type: 'question',
          responseSchema: stringSchema,
          presentation: {},
          bindingDigest: 'fixed',
        },
        context,
      ),
      'value',
    );
  assert.equal(
    (
      await waits.respond(
        ticket,
        'yes',
        'a',
        localContext({ principal: { subject: 'stranger', authority: 'local' } }),
      )
    ).ok,
    false,
  );
  assert.equal((await waits.respond(ticket, 1, 'a', context)).ok, false);
  const pending = waits.wait(ticket, stringSchema, context);
  assert.equal((await waits.respond(ticket, 'yes', 'a', context)).ok, true);
  assert.equal(expectProperty(await pending, 'value'), 'yes');
  assert.equal((await waits.respond(ticket, 'yes', 'a', context)).ok, true);
  assert.equal((await waits.respond(ticket, 'no', 'a', context)).ok, false);
  assert.equal((await waits.respond(ticket, 'yes', 'b', context)).ok, false);
});

test('synchronous composition hashing matches native SHA-256', async () => {
  const { sha256 } = await import('../packages/core/dist/foundation/hash.js');
  const { digest } = await import('@slop-lab/part/contracts/index.js');
  for (const text of ['', 'abc', '한국어', 'x'.repeat(1000)]) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(sha256(bytes), await digest(bytes));
  }
});

test('E03: cancellation during awaited prepare prevents the next executor attempt', async () => {
  const controller = new AbortController(),
    c = localContext({ signal: controller.signal });
  let count = 0;
  const gate =
    /** @type {PromiseWithResolvers<import("@slop-lab/part/reference/index.js").Contracts.Result<void>>} */ (
      deferred()
    );
  const boundary = createBoundary({
    prepare: () => gate.promise,
  });
  const pending = managedAttempt(
    boundary,
    plan,
    async () => {
      count++;
      return { kind: 'returned', value: 1, effect: 'applied' };
    },
    c,
  );
  await delay(0);
  controller.abort();
  gate.resolve(ok(undefined));
  const outcome = await pending;
  assert.equal(count, 0);
  assert.equal(outcome.effect, 'not-attempted');
});
test('E05: attached operations inherit deadlines and share concurrent reservations', async () => {
  const operations = createOperations(),
    budget = createBudget({ maxConcurrentOperations: 1 }),
    c = localContext({ services: singleService(budgetKey, budget) });
  let entered = 0;
  const first = expectProperty(
    await operations.begin(
      spec,
      async () => {
        entered++;
        await delay(10);
        return completed(1);
      },
      c,
    ),
    'value',
  );
  const second = await operations.begin(
    spec,
    async () => {
      entered++;
      return completed(2);
    },
    c,
  );
  assert.equal(second.ok, false);
  await first.done;
  assert.equal(entered, 1);
  const third = await operations.begin(spec, async () => completed(3), c);
  assert.equal(expectProperty(await expectProperty(third, 'value').done, 'result'), 3);
});

test('long wait expiry does not overflow into immediate expiration', async () => {
  const waits = createSuspensions();
  const ticket = expectProperty(
    await waits.open(
      {
        type: 'long',
        responseSchema: jsonSchema,
        presentation: {},
        bindingDigest: 'bound',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      context,
    ),
    'value',
  );
  await delay(5);
  assert.equal(expectProperty(waits.get(ticket.id), 'value').state, 'open');
  waits.cancel(ticket.id);
});

test('E05: a child cannot widen its parent deadline', async () => {
  const operations = createOperations(),
    deadline = new Date(Date.now() + 1000).toISOString();
  const parent = expectProperty(
    await operations.begin(
      spec,
      async (c) => {
        const child = await operations.begin(
          { ...spec, parent: { owner: 'part/operations', kind: 'test', id: c.scope.id } },
          async (childContext) => {
            assert.equal(childContext.deadline, deadline);
            return completed(1);
          },
          { ...c, deadline: new Date(Date.now() + 5000).toISOString() },
        );
        return completed(expectProperty(await expectProperty(child, 'value').done, 'result'));
      },
      localContext({ deadline }),
    ),
    'value',
  );
  assert.equal((await parent.done).phase, 'completed');
});

test('Attached work from a separately configured service joins the parent supervisor', async () => {
  const owner = createOperations({ cancellationGraceMs: 5 }),
    separate = createOperations({ cancellationGraceMs: 100 });
  /** @type {import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<unknown> | undefined} */
  let child;
  const parent = await owner.begin(
    { kind: 'test/parent', childPolicy: 'attached', retryOwner: 'test' },
    async (context) => {
      child = expectProperty(
        await separate.begin(
          { kind: 'test/child', childPolicy: 'attached', retryOwner: 'test' },
          async () => new Promise(() => {}),
          context,
        ),
        'value',
      );
      return {
        phase: 'completed',
        result: 'must not succeed',
        effect: 'not-applied',
        commit: [],
        unsettledChildren: [],
      };
    },
    localContext(),
  );
  const outcome = await expectProperty(parent, 'value').done;
  assert.equal(outcome.phase, 'abandoned');
  assert.ok(child);
  assert.equal(present(outcome.unsettledChildren[0]).id, child.ref.id);
  assert.ok(child);
  assert.equal(owner.get(child.ref).ok, true);
});

test('Unresolved driver cleanup is abandoned and retains the actual resource reference', async () => {
  const { createRunService, installDriver } = await import('@slop-lab/part/runtime/runs.js');
  const operations = createOperations();
  let disposals = 0;
  const ref = { owner: 'test/driver', kind: 'test/resource', id: 'unclosed' };
  const driver = installDriver({
    id: 'test/cleanup',
    version: '1',
    input: jsonSchema,
    output: jsonSchema,
    requires: [],
    create: () => ({
      execute: async () => completed(null),
      describeActions: () => [],
      receive: async () => fail('test.action', 'No action'),
      dispose: async () => {
        disposals++;
        return { released: [], unresolved: [ref], errors: [] };
      },
    }),
  });
  const service = expectProperty(
    createRunService({
      drivers: [driver],
      operations,
      services: { operations, services: context.services },
    }),
    'value',
  );
  const composition = expectProperty(
    createPlanner().resolve({ components: [], config: {} }),
    'value',
  );
  const handle = expectProperty(
    await service.start({ driver: driver.id, composition, input: null }, context),
    'value',
  );
  const result = await handle.done;
  assert.equal(result.phase, 'abandoned');
  assert.equal(result.effect, 'unknown');
  assert.deepEqual(result.unsettledChildren, [ref]);
  assert.equal(disposals, 1);
});
