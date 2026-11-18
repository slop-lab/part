// @ts-check
import { createPlanner, createScopeManager } from '@slop-lab/part/composition/index.js';
import { fail, ok } from '@slop-lab/part/contracts/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, present } from '../fixtures/assertions.mjs';

/** @type {import('@slop-lab/part/reference/index.js').Composition.ExtensionPoint<number>} */
const point = {
  id: 'test/registry',
  owner: 'test',
  contractVersion: 1,
  kind: 'registry',
  scope: 'runtime',
};
/**
 * @param {string} id
 * @param {import('@slop-lab/part/reference/index.js').Composition.ComponentFactory['register']} register
 * @param {import('@slop-lab/part/reference/index.js').Composition.ComponentDescriptor['requires']} requires
 * @param {import('@slop-lab/part/reference/index.js').Composition.ComponentDescriptor['provides']} provides
 * @param {Partial<import('@slop-lab/part/reference/index.js').Composition.ComponentLifecycle>} lifecycle
 * @returns {import('@slop-lab/part/reference/index.js').Composition.ComponentFactory}
 */
const component = (id, register, requires = [], provides = [], lifecycle = {}) => ({
  descriptor: { id, version: '1', scope: 'runtime', surfaces: ['test'], requires, provides },
  register,
  create: () =>
    ok({
      initialize: async () => ok(undefined),
      start: async () => ok(undefined),
      stop: async () => ({ released: [], unresolved: [], errors: [] }),
      dispose: async () => ({ released: [], unresolved: [], errors: [] }),
      ...lifecycle,
    }),
});

test('C03-C05: missing dependencies, duplicate keys, replacement, deterministic ordering and cycles', () => {
  const planner = createPlanner();
  assert.equal(
    planner.resolve({
      components: [
        component('a', () => ok(undefined), [
          { id: 'missing', contractVersion: 1, optional: false },
        ]),
      ],
      config: {},
    }).ok,
    false,
  );
  /** @type {import("@slop-lab/part/reference/index.js").Composition.ComponentFactory["register"]} */
  const register = (r) => {
    r.declare(point);
    r.contribute({ id: 'z', point: { ...point }, key: 'z', value: 1 });
    r.contribute({ id: 'a', point, key: 'a', value: 2, after: ['z'] });
    return ok(undefined);
  };
  const resolved = planner.resolve({ components: [component('a', register)], config: {} });
  assert.equal(resolved.ok, true);
  assert.deepEqual(present(resolved.value.inspection.orderedBindings[0]).contributions, ['z', 'a']);
  assert.equal(
    planner.resolve({
      components: [component('a', register)],
      config: {},
      edits: [(r) => r.contribute({ id: 'dup', point, key: 'z', value: 3 })],
    }).ok,
    false,
  );
  assert.equal(
    planner.resolve({
      components: [component('a', register)],
      config: {},
      edits: [
        (r) => r.replace({ point, replaces: 'z', with: { id: 'z', point, key: 'z', value: 9 } }),
      ],
    }).ok,
    true,
  );
  assert.equal(
    planner.resolve({
      components: [component('a', register)],
      config: {},
      edits: [
        (r) =>
          r.replace({ point, replaces: 'absent', with: { id: 'x', point, key: 'x', value: 9 } }),
      ],
    }).ok,
    false,
  );
  assert.equal(
    planner.resolve({
      components: [component('a', register)],
      config: {},
      edits: [
        (r) =>
          r.replace({
            point,
            replaces: 'z',
            with: { id: 'z', point, key: 'z', value: 9, after: ['a'] },
          }),
      ],
    }).ok,
    false,
  );
});
test('C06: initialization failure disposes created modules in reverse order', async () => {
  /** @type {string[]} */
  const log = [],
    /** @param {string} id */
    cleanup = /** @param {string} id */ (id) => async () => {
      log.push(id);
      return { released: [], unresolved: [], errors: [] };
    };
  const components = ['a', 'b', 'c'].map((id) =>
    component(id, () => ok(undefined), [], [], {
      initialize: async () => (id === 'c' ? fail('fixture', 'Failure') : ok(undefined)),
      stop: cleanup(`stop-${id}`),
      dispose: cleanup(`dispose-${id}`),
    }),
  );
  const composition = expectProperty(createPlanner().resolve({ components, config: {} }), 'value');
  const opened = await createScopeManager().open({ kind: 'runtime', id: 'r' }, composition);
  assert.equal(opened.ok, false);
  assert.deepEqual(log, ['dispose-c', 'stop-b', 'dispose-b', 'stop-a', 'dispose-a']);
});

test('factory replacement preserves dependent service construction and exposes cleanup evidence', async () => {
  /** @type {import('@slop-lab/part/reference/index.js').Composition.ExtensionPoint<number>} */
  const servicePoint = {
      id: 'test/service',
      owner: 'test',
      contractVersion: 1,
      kind: 'service',
      scope: 'runtime',
    },
    dependentPoint = { ...servicePoint, id: 'test/dependent' };
  const registered = component('factories', (registry) => {
    registry.declare(servicePoint);
    registry.declare(dependentPoint);
    registry.provide(servicePoint, {
      id: 'original',
      scope: 'runtime',
      dependencies: [],
      create: async () => {
        throw Error('Replaced factory must not initialize');
      },
    });
    return registry.provide(dependentPoint, {
      id: 'dependent',
      scope: 'runtime',
      dependencies: [{ id: servicePoint.id, contractVersion: 1, scope: 'runtime' }],
      create: async (_config, c) =>
        ok({
          value: expectProperty(c.services.get(servicePoint), 'value'),
          dispose: async () => ({ released: [], unresolved: [], errors: [] }),
        }),
    });
  });
  const resolved = createPlanner().resolve({
    components: [registered],
    config: {},
    edits: [
      (registry) =>
        registry.replace({
          point: servicePoint,
          replaces: 'original',
          with: { id: 'replacement', point: servicePoint, value: 42 },
        }),
    ],
  });
  assert.equal(resolved.ok, true);
  const lease = expectProperty(
    await createScopeManager().open({ kind: 'runtime', id: 'factory-scope' }, resolved.value),
    'value',
  );
  assert.equal(expectProperty(lease.services.get(dependentPoint), 'value'), 42);
  await lease.close();
  const unresolved = { owner: 'test', kind: 'resource', id: 'unresolved' };
  const failed = component('failed', () => ok(undefined), [], [], {
    initialize: async () => fail('init', 'Failed'),
    dispose: async () => ({ released: [], unresolved: [unresolved], errors: [] }),
  });
  const composition = expectProperty(
    createPlanner().resolve({ components: [failed], config: {} }),
    'value',
  );
  const failure = await createScopeManager().open({ kind: 'runtime', id: 'failed' }, composition);
  assert.deepEqual(
    expectProperty(
      expectProperty(expectProperty(failure, 'error').details, 'cleanup'),
      'unresolved',
    ),
    [unresolved],
  );
});
