// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createCodingDriver } from '@slop-lab/part-plugins/swe/coding.js';
import { createSubagentTools, subagentToolId } from '@slop-lab/part-plugins/swe/subagents.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { fail, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { budgetKey, createBudget } from '@slop-lab/part/runtime/budget.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, present, stub } from '../fixtures/assertions.mjs';

test('coding completion fails when a required workspace check did not pass', async () => {
  // Given: a model claims completion while validation reports a failing check.
  const driver = createCodingDriver({
    profileId: 'fake',
    validate: async () =>
      ok({ summary: 'not ready', checks: [{ id: 'tests', passed: false, detail: 'failed' }] }),
  });
  const agent = expectProperty(
    createAgent({ model: fakeModel([{ text: 'done' }]), driver }),
    'value',
  );

  // When: the coding run reaches a provider stop.
  const outcome = expectProperty(await agent.generate('fix it'), 'value');

  // Then: provider prose cannot produce false success.
  assert.equal(outcome.phase, 'failed');
  assert.equal(expectProperty(expectProperty(outcome, 'error'), 'code'), 'part.swe.completion');
  await agent.dispose();
});

test('coding completion preserves the basic Model.Response when every check passes', async () => {
  // Given: completion validation supplies at least one passing check.
  const driver = createCodingDriver({
    profileId: 'fake',
    validate: async () => ok({ summary: 'ready', checks: [{ id: 'tests', passed: true }] }),
  });
  const agent = expectProperty(
    createAgent({ model: fakeModel([{ text: 'done' }]), driver }),
    'value',
  );

  // When: the coding run completes.
  const outcome = expectProperty(await agent.generate('fix it'), 'value');

  // Then: validation gates completion without changing the basic driver output contract.
  assert.equal(expectProperty(expectProperty(outcome, 'result').content[0], 'text'), 'done');
  await agent.dispose();
});

test('subagent execution receives explicit authority and the parent invocation context', async () => {
  // Given: a child-run port records its managed request and context.
  /** @type {import('@slop-lab/part-plugins/swe/subagents.js').ManagedChildRequest | undefined} */
  let seenRequest;
  /** @type {import('@slop-lab/part/reference/index.js').Contracts.InvocationContext | undefined} */
  let seenContext;
  /** @type {import('@slop-lab/part-plugins/swe/subagents.js').ChildRunPort<import('@slop-lab/part/reference/index.js').Contracts.Json>} */
  const childRuns = {
    start: async (request, context) => {
      seenRequest = request;
      seenContext = context;
      return ok(completedHandle({ answer: 'child result' }));
    },
  };
  const dispatcher = expectProperty(
    createToolDispatcher({
      tools: createSubagentTools({
        childRuns,
        driverId: 'part/swe-child',
        authority: { purpose: 'implementation', allowedActions: ['read', 'edit', 'test'] },
      }),
    }),
    'value',
  );
  const budget = createBudget({ maxChildRuns: 2 });
  const services = stub({
    get: /** @type {import('@slop-lab/part/reference/index.js').Contracts.ServiceAccess['get']} */ (
      (key) =>
        key.id === budgetKey.id ? stub(ok(budget)) : fail('service.missing', key.id, 'unsupported')
    ),
  });
  const context = localContext({
    principal: { subject: 'parent-agent', authority: 'test/host' },
    scope: { kind: 'operation', id: 'parent-run' },
    services,
  });

  // When: the runtime dispatches the subagent tool.
  const handle = expectProperty(
    await dispatcher.dispatch(
      {
        logicalCallId: 'call-1',
        toolId: subagentToolId,
        arguments: { task: 'implement feature', context: 'repository facts' },
      },
      context,
    ),
    'value',
  );
  const outcome = await handle.done;

  // Then: no ambient authority or independent scheduler is invented.
  assert.equal(outcome.phase, 'completed');
  assert.equal(
    expectProperty(expectProperty(expectProperty(outcome, 'result'), 'value'), 'status'),
    'completed',
  );
  const request = present(seenRequest),
    childContext = present(seenContext);
  assert.equal(request.authority.principal.subject, 'parent-agent');
  assert.equal(request.parent.id, handle.ref.id);
  assert.equal(expectProperty(childContext.services.get(budgetKey), 'value'), budget);
});

test('subagent tools enforce the child bound independently for each root run', async () => {
  // Given: a tool set owns at most one child per root correlation.
  let starts = 0;
  /** @type {import('@slop-lab/part-plugins/swe/subagents.js').ChildRunPort<import('@slop-lab/part/reference/index.js').Contracts.Json>} */
  const childRuns = {
    start: async () => {
      starts++;
      return ok(completedHandle({ answer: starts }));
    },
  };
  const dispatcher = expectProperty(
    createToolDispatcher({
      tools: createSubagentTools({
        childRuns,
        driverId: 'part/swe-child',
        authority: { purpose: 'implementation', allowedActions: ['read'] },
        maxChildren: 1,
      }),
    }),
    'value',
  );
  const firstRoot = localContext({ correlationId: 'root-1' });
  const secondRoot = localContext({ correlationId: 'root-2' });
  /** @param {string} id @param {import('@slop-lab/part/reference/index.js').Contracts.InvocationContext} context */
  const call = (id, context) =>
    dispatcher.dispatch(
      {
        logicalCallId: id,
        toolId: subagentToolId,
        arguments: { task: id, context: 'facts' },
      },
      context,
    );

  // When: a second child is requested.
  await expectProperty(await call('first', firstRoot), 'value').done;
  const second = await expectProperty(await call('second', firstRoot), 'value').done;
  const otherRoot = await expectProperty(await call('other-root', secondRoot), 'value').done;

  // Then: the same root is rejected, while another root receives its own allowance.
  assert.equal(starts, 2);
  assert.equal(second.phase, 'failed');
  assert.equal(expectProperty(expectProperty(second, 'error'), 'code'), 'part.swe.child-limit');
  assert.equal(otherRoot.phase, 'completed');
});

test('subagent failure preserves child effect evidence', async () => {
  // Given: a managed child fails after applying an effect.
  const failed = completedHandle({ unused: true });
  /** @type {import('@slop-lab/part-plugins/swe/subagents.js').ChildRunPort<import('@slop-lab/part/reference/index.js').Contracts.Json>} */
  const childRuns = {
    start: async () =>
      ok({
        ...failed,
        done: Promise.resolve({
          phase: 'failed',
          error: fail('child.failed', 'Child failed', 'internal').error,
          effect: 'applied',
          commit: [],
          unsettledChildren: [],
        }),
      }),
  };
  const dispatcher = expectProperty(
    createToolDispatcher({
      tools: createSubagentTools({
        childRuns,
        driverId: 'part/swe-child',
        authority: { purpose: 'implementation', allowedActions: ['read'] },
      }),
    }),
    'value',
  );

  // When: the subagent tool awaits the child outcome.
  const outcome = await expectProperty(
    await dispatcher.dispatch(
      {
        logicalCallId: 'failed-child',
        toolId: subagentToolId,
        arguments: { task: 'fail', context: 'facts' },
      },
      localContext(),
    ),
    'value',
  ).done;

  // Then: the tool does not return false success and preserves the applied effect.
  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.effect, 'applied');
  assert.equal(expectProperty(expectProperty(outcome, 'error'), 'code'), 'part.child.failed');
});

test('subagent execution propagates parent cancellation to the managed child', async () => {
  // Given: a child remains active until cancellation is acknowledged.
  /** @type {PromiseWithResolvers<import('@slop-lab/part/reference/index.js').Runtime.ManagedOutcome<import('@slop-lab/part/reference/index.js').Contracts.Json>>} */
  const childDone = Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const childStarted = Promise.withResolvers();
  let cancellations = 0;
  /** @type {import('@slop-lab/part-plugins/swe/subagents.js').ChildRunPort<import('@slop-lab/part/reference/index.js').Contracts.Json>} */
  const childRuns = {
    start: async () => {
      childStarted.resolve(undefined);
      return ok({
        ...completedHandle({ unused: true }),
        done: childDone.promise,
        requestCancel: async () => {
          cancellations++;
          childDone.resolve({
            phase: 'cancelled',
            effect: 'not-attempted',
            commit: [],
            unsettledChildren: [],
          });
          return ok({ state: 'confirmed', unresolvedTargets: [] });
        },
      });
    },
  };
  const dispatcher = expectProperty(
    createToolDispatcher({
      tools: createSubagentTools({
        childRuns,
        driverId: 'part/swe-child',
        authority: { purpose: 'implementation', allowedActions: ['read'] },
      }),
    }),
    'value',
  );
  const controller = new AbortController();
  const context = localContext({ signal: controller.signal });

  // When: the parent invocation is cancelled during child execution.
  const running = expectProperty(
    await dispatcher.dispatch(
      {
        logicalCallId: 'cancelled-child',
        toolId: subagentToolId,
        arguments: { task: 'wait', context: 'facts' },
      },
      context,
    ),
    'value',
  );
  await childStarted.promise;
  controller.abort();
  const outcome = await running.done;

  // Then: cancellation reaches the child and the tool operation does not report success.
  assert.equal(cancellations, 1);
  assert.equal(outcome.phase, 'cancelled');
});

/**
 * @param {import('@slop-lab/part/reference/index.js').Contracts.Json} value
 * @returns {import('@slop-lab/part/reference/index.js').Runtime.ExecutionHandle<import('@slop-lab/part/reference/index.js').Contracts.Json>}
 */
function completedHandle(value) {
  const ref = { owner: 'test', kind: 'part/run', id: crypto.randomUUID() };
  return {
    ref,
    done: Promise.resolve({
      phase: 'completed',
      result: value,
      effect: 'not-attempted',
      commit: [],
      unsettledChildren: [],
    }),
    snapshot: () => ({
      ref,
      revision: '1',
      phase: 'completed',
      cancel: { state: 'not-requested', unresolvedTargets: [] },
      effect: 'not-attempted',
    }),
    observe: async function* () {},
    requestCancel: async () => ok({ state: 'confirmed', unresolvedTargets: [] }),
  };
}
