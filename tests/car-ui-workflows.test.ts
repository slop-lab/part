import assert from 'node:assert/strict';
import test from 'node:test';
import { connectedUi, createWindow, delay, fakePort, until } from '../fixtures/car-ui.mjs';
import type { Client, Contracts, Projection } from '@slop-lab/part/reference/index.js';

test('CAR discovers definitions and sends exactly one supported workflow start and targeted cancel command', async () => {
  const window = createWindow();
  const operation = { owner: 'workflow', kind: 'execution', id: 'exec-1' };
  const fixture = fakePort(
    {
      'car.run/list': [],
      'part.workflow/definitions': [
        {
          engineId: 'part/recipe',
          definition: { id: 'review', digest: 'digest-1' },
          profileIds: ['default'],
          composition: { id: 'car', revision: '7' },
        },
      ],
    },
    {
      deliveries: [
        {
          kind: 'receipt',
          receipt: {
            kind: 'accepted',
            commandId: 'server-echo',
            operation,
            commit: [],
          },
        },
      ],
    },
  );
  const { ui } = await connectedUi(window, fixture);
  (ui.element.querySelector('[data-car-tab="workflows"]') as HTMLButtonElement).click();
  await until(() => ui.element.textContent.includes('review'));
  const form = ui.element.querySelector('[data-car-query="workflow-start"]') as HTMLFormElement;
  const input = form.elements.namedItem('input') as HTMLTextAreaElement;
  input.value = '{"ticket":42}';
  form.requestSubmit();
  await until(() => ui.element.textContent.includes('Accepted'));
  assert.equal(fixture.commands.length, 1);
  const start = fixture.commands[0];
  assert.ok(start);
  assert.equal(start.commandId, start.idempotencyKey);
  assert.deepEqual(
    { ...start, commandId: 'same', idempotencyKey: 'same' },
    {
      protocolVersion: 1,
      commandId: 'same',
      idempotencyKey: 'same',
      actionId: 'part.workflow/start',
      actionVersion: 1,
      input: {
        engineId: 'part/recipe',
        definition: { id: 'review', digest: 'digest-1' },
        profileId: 'default',
        composition: { id: 'car', revision: '7' },
        input: { ticket: 42 },
        requiredControl: 'runner-enforced',
        requiredCapabilities: [],
      },
    },
  );
  (ui.element.querySelector('[data-car-action="workflow-cancel"]') as HTMLButtonElement).click();
  await until(() => /Cancellation completed|Cancellation accepted/.test(ui.element.textContent));
  const cancel = fixture.commands[1];
  assert.ok(cancel);
  assert.equal(cancel.actionId, 'part.workflow/cancel');
  assert.deepEqual(cancel.target, operation);
  assert.equal(cancel.input, null);
  assert.match(ui.element.textContent, /Cancellation completed|Cancellation accepted/);
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR reports rejected and unknown workflow starts without automatic repeat', async () => {
  const cases: readonly (readonly [Client.CommandDelivery, string])[] = [
    [
      {
        kind: 'receipt',
        receipt: {
          kind: 'rejected',
          commandId: 'rejected',
          error: {
            code: 'workflow.denied',
            category: 'permission',
            message: 'Definition denied',
            retry: 'never',
          },
        },
      },
      'Rejected: Definition denied',
    ],
    [
      {
        kind: 'unknown',
        commandId: 'unknown',
        recovery: 'same-key-retry',
        error: {
          code: 'http.delivery',
          category: 'unavailable',
          message: 'Receipt unavailable',
          retry: 'unspecified',
        },
      },
      'Delivery unknown. The request was not repeated.',
    ],
  ];
  for (const [delivery, expected] of cases) {
    const window = createWindow();
    const fixture = fakePort(
      {
        'car.run/list': [],
        'part.workflow/definitions': [
          {
            engineId: 'engine',
            definition: { id: 'one', digest: 'digest' },
            profileIds: ['default'],
            composition: { id: 'car', revision: '1' },
          },
        ],
      },
      { deliveries: [delivery] },
    );
    const { ui } = await connectedUi(window, fixture);
    (ui.element.querySelector('[data-car-tab="workflows"]') as HTMLButtonElement).click();
    await until(() => ui.element.textContent.includes('one'));
    (
      ui.element.querySelector('[data-car-query="workflow-start"]') as HTMLFormElement
    ).requestSubmit();
    await until(() => ui.element.textContent.includes(expected));
    await delay(5);
    assert.equal(fixture.commands.length, 1);
    await ui.dispose();
    window.happyDOM.cancelAsync();
  }
});

test('CAR Chat workflow renderer submits wait responses through the projected source target', async () => {
  const window = createWindow();
  const source = { owner: 'workflow', kind: 'execution', id: 'exec-wait' };
  const workflow: Projection.Item = {
    id: 'exec-wait',
    type: 'part/workflow',
    schemaVersion: 1,
    revision: '2',
    source,
    payload: {
      phase: 'waiting',
      effect: 'not-applied',
      waits: [
        {
          ticket: { id: 'approval', revision: '3' },
          presentation: { prompt: 'Approve result?' },
        },
      ],
    },
    fallback: { label: 'Workflow', text: 'waiting' },
    actions: [
      {
        id: 'part.workflow/respond',
        version: 1,
        input: { id: 'part/json', version: 1 },
        output: { id: 'part/json', version: 1 },
        execution: 'immediate',
        availability: { state: 'available', checkedAt: '2' },
      },
    ],
    artifacts: [],
  };
  const fixture = fakePort({ 'car.run/list': [] }, { items: [workflow] });
  const { ui } = await connectedUi(window, fixture);
  await until(() => ui.element.textContent.includes('Approve result?'));
  const response = ui.element.querySelector(
    'textarea[aria-label="JSON input for part.workflow/respond"]',
  ) as HTMLTextAreaElement;
  response.value = '{"ticketId":"approval","revision":"3","response":true}';
  response.dispatchEvent(new window.Event('input'));
  (response.closest('form') as HTMLFormElement).requestSubmit();
  await until(() => fixture.commands.length === 1);
  assert.equal(fixture.commands[0]?.actionId, 'part.workflow/respond');
  assert.deepEqual(fixture.commands[0]?.target, source);
  assert.deepEqual(fixture.commands[0]?.input, {
    ticketId: 'approval',
    revision: '3',
    response: true,
  });
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR disposal ignores a late workflow definitions response', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  let resolveDefinitions: (result: Contracts.Result<Contracts.Json>) => void = () => {};
  const definitions = new Promise<Contracts.Result<Contracts.Json>>((resolve) => {
    resolveDefinitions = resolve;
  });
  let requested = false;
  const query = fixture.port.query.bind(fixture.port);
  fixture.port.query = (request, options) => {
    if (request.queryId === 'part.workflow/definitions') {
      requested = true;
      return definitions;
    }
    return query(request, options);
  };
  const { ui } = await connectedUi(window, fixture);
  (ui.element.querySelector('[data-car-tab="workflows"]') as HTMLButtonElement).click();
  await until(() => requested);
  const launcher = ui.element
    .querySelector('[data-car-query="workflow-start"]')
    ?.closest('section') as HTMLElement;
  const snapshot = launcher.textContent;
  await ui.dispose();
  resolveDefinitions({
    ok: true,
    value: [
      {
        engineId: 'late',
        definition: { id: 'late', digest: 'late' },
        profileIds: ['default'],
        composition: { id: 'late', revision: '1' },
      },
    ],
  });
  await delay(0);
  assert.equal(launcher.textContent, snapshot);
  window.happyDOM.cancelAsync();
});
