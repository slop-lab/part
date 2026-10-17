// @ts-check
import { createCarUi } from '../car/ui/app.mjs';
import { buildCarUi } from '../car/scripts/build-ui.mjs';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const delay = /** @param {number} ms */ (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createWindow() {
  return /** @type {globalThis.Window & typeof globalThis & {happyDOM: import('happy-dom').Window['happyDOM']}} */ (
    /** @type {unknown} */ (new Window({ url: 'https://car.test/' }))
  );
}

/** @param {() => boolean} predicate */
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error('Timed out waiting for CAR UI state');
}

/** @param {Record<string, import('@slop-lab/part/reference/index.js').Contracts.Json>} values
 * @param {{items?: readonly import('@slop-lab/part/reference/index.js').Projection.Item[],
 * deliveries?: import('@slop-lab/part/reference/index.js').Client.CommandDelivery[]}=} options */
function fakePort(values, options = {}) {
  /** @type {{queryId: string, version: number, input: import('@slop-lab/part/reference/index.js').Contracts.Json}[]} */
  const queries = [];
  /** @type {import('@slop-lab/part/reference/index.js').Contracts.CommandRequest[]} */
  const commands = [];
  let closed = false;
  /** @type {import('@slop-lab/part/reference/index.js').Client.Port} */
  const port = {
    async command(request) {
      commands.push(request);
      return (
        options.deliveries?.shift() ?? {
          kind: 'receipt',
          receipt: {
            kind: 'completed',
            commandId: request.commandId,
            result: null,
            effect: 'not-applied',
            commit: [],
          },
        }
      );
    },
    async query(request) {
      queries.push(request);
      const value = values[request.queryId];
      if (value === undefined)
        return {
          ok: false,
          error: {
            code: 'car.permission',
            category: 'permission',
            message: 'Inspector access denied',
            retry: 'never',
          },
        };
      return { ok: true, value };
    },
    async discover() {
      return { ok: true, value: { revision: '1', entries: [] } };
    },
    async watch() {
      return {
        ok: true,
        value: {
          bootstrap: {
            epoch: 'test',
            streamId: 'test',
            throughSequence: 0,
            cursor: 'test:0',
            audienceRevision: '1',
            items: options.items ?? [],
            streamingParts: [],
            capabilities: { revision: '1', entries: [] },
          },
          async close() {
            closed = true;
          },
          frames: {
            async *[Symbol.asyncIterator]() {
              while (!closed) await delay(5);
            },
          },
        },
      };
    },
  };
  return { port, queries, commands };
}

/** @param {ReturnType<typeof createWindow>} window @param {ReturnType<typeof fakePort>} fixture */
async function connectedUi(window, fixture) {
  /** @typedef {NonNullable<Parameters<typeof createCarUi>[0]>} CarUiOptions */
  /** @type {Parameters<NonNullable<CarUiOptions['portFactory']>>[1] | undefined} */
  let portOptions;
  /** @type {string | undefined} */
  let portUrl;
  const ui = createCarUi({
    document: window.document,
    baseUrl: 'https://car.test/',
    portFactory(url, options) {
      portUrl = url;
      portOptions = options;
      return fixture.port;
    },
  });
  window.document.body.append(ui.element);
  const token = /** @type {HTMLInputElement} */ (ui.element.querySelector('[name="token"]'));
  token.value = 'user-secret';
  /** @type {HTMLFormElement} */ (
    ui.element.querySelector('[data-car-part="connection"]')
  ).requestSubmit();
  await until(() => ui.element.querySelector('[data-car-state="connected"]') !== null);
  return { ui, portUrl, portOptions };
}

test('CAR connects to the same origin with an in-memory bearer token and mounts shared Chat', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  const { ui, portUrl, portOptions } = await connectedUi(window, fixture);
  assert.equal(portUrl, 'https://car.test/');
  assert.deepEqual(portOptions?.headers?.(), { authorization: 'Bearer user-secret' });
  assert.ok(ui.element.querySelector('[aria-label="Agent chat"]'));
  assert.equal(ui.element.textContent.includes('user-secret'), false);
  assert.equal(window.localStorage.length, 0);
  const textarea = /** @type {HTMLTextAreaElement} */ (ui.element.querySelector('textarea'));
  textarea.value = 'inspect this repository';
  textarea.dispatchEvent(new window.Event('input'));
  /** @type {HTMLFormElement} */ (textarea.form).requestSubmit();
  await until(() => textarea.value === '');
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR tabs perform version-1 refresh queries and distinguish metadata from full trace', async () => {
  const window = createWindow();
  const fixture = fakePort({
    'car.run/list': [],
    'car.context/get': [{ id: 'ctx', digest: 'abc', decisions: ['bounded'], losses: [] }],
    'car.config/get': { trace: 'metadata', root: '/repo' },
  });
  const { ui } = await connectedUi(window, fixture);
  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="context"]')).click();
  await until(() => ui.element.textContent.includes('abc'));
  assert.match(ui.element.textContent, /metadata-only/i);
  const before = fixture.queries.filter((query) => query.queryId === 'car.context/get').length;
  /** @type {HTMLButtonElement} */ (
    ui.element.querySelector('[data-car-action="refresh"]')
  ).click();
  await until(
    () => fixture.queries.filter((query) => query.queryId === 'car.context/get').length > before,
  );
  assert.ok(fixture.queries.every((query) => query.version === 1));
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR renders permission errors, files, diffs, logs, JSON, and artifacts as inert text', async () => {
  const window = createWindow();
  const dangerous = '<script>globalThis.compromised=true</script>';
  const fixture = fakePort({
    'car.run/list': [{ id: 'run-1', log: dangerous }],
    'car.workspace/read': { content: dangerous, digest: 'deadbeef', lines: 1, truncated: false },
    'car.workspace/diff': { content: `-${dangerous}\n+safe`, truncated: false },
    'car.artifact/read': {
      encoding: 'base64',
      bytes: Buffer.from(dangerous).toString('base64'),
    },
  });
  const { ui } = await connectedUi(window, fixture);
  assert.equal(ui.element.querySelector('script'), null);
  assert.ok(ui.element.textContent.includes(dangerous));

  /** @type {readonly (readonly [string, Readonly<Record<string, string>>])[]} */
  const queryFixtures = [
    ['workspace', { path: 'src/file.js' }],
    ['diff', { path: 'src/file.js' }],
    ['artifact', { store: 'car', id: 'artifact-1' }],
  ];
  for (const [tab, fields] of queryFixtures) {
    /** @type {HTMLButtonElement} */ (ui.element.querySelector(`[data-car-tab="${tab}"]`)).click();
    for (const [name, value] of Object.entries(fields))
      /** @type {HTMLInputElement} */ (ui.element.querySelector(`[name="${name}"]`)).value = value;
    /** @type {HTMLFormElement} */ (
      ui.element.querySelector(`[data-car-query="${tab}"]`)
    ).requestSubmit();
    await until(() => ui.element.textContent.includes(dangerous));
    assert.equal(ui.element.querySelector('script'), null);
  }

  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="requests"]')).click();
  await until(() => ui.element.textContent.includes('Inspector access denied'));
  assert.match(ui.element.textContent, /permission/i);
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR ignores a delayed prior-tab query and clears its status when another tab is selected', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  /** @type {(result: import('@slop-lab/part/reference/index.js').Contracts.Result<import('@slop-lab/part/reference/index.js').Contracts.Json>) => void} */
  let resolveDiff = () => {};
  const delayedDiff = new Promise((resolve) => {
    resolveDiff = resolve;
  });
  let requested = false;
  const query = fixture.port.query.bind(fixture.port);
  fixture.port.query = (request, options) => {
    if (request.queryId === 'car.workspace/diff') {
      requested = true;
      return delayedDiff;
    }
    return query(request, options);
  };
  const { ui } = await connectedUi(window, fixture);
  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="diff"]')).click();
  /** @type {HTMLFormElement} */ (
    ui.element.querySelector('[data-car-query="diff"]')
  ).requestSubmit();
  await until(() => requested);
  const status = /** @type {HTMLElement} */ (ui.element.querySelector('.car-inspector-status'));
  assert.equal(status.dataset.state, 'loading');
  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="artifact"]')).click();
  assert.equal(status.textContent, '');
  assert.equal(status.dataset.state, 'idle');
  resolveDiff({
    ok: false,
    error: {
      code: 'diff.failed',
      category: 'unavailable',
      message: 'Old diff failed',
      retry: 'safe-read',
    },
  });
  await delay(0);
  assert.ok(ui.element.querySelector('[data-car-query="artifact"]'));
  assert.equal(ui.element.textContent.includes('Old diff failed'), false);
  assert.equal(status.textContent, '');
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR inspector status is tab-scoped across errors, Items, and Workflows', async () => {
  const window = createWindow();
  const fixture = fakePort({
    'car.run/list': [],
    'part.workflow/definitions': [],
  });
  const { ui } = await connectedUi(window, fixture);
  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="diff"]')).click();
  /** @type {HTMLFormElement} */ (
    ui.element.querySelector('[data-car-query="diff"]')
  ).requestSubmit();
  await until(() => ui.element.textContent.includes('Inspector access denied'));
  const status = /** @type {HTMLElement} */ (ui.element.querySelector('.car-inspector-status'));
  assert.equal(status.dataset.state, 'error');
  for (const tab of ['items', 'workflows']) {
    /** @type {HTMLButtonElement} */ (ui.element.querySelector(`[data-car-tab="${tab}"]`)).click();
    assert.equal(status.textContent, '');
    assert.equal(status.dataset.state, 'idle');
  }
  await until(() => ui.element.textContent.includes('No workflow definition'));
  const workflowStatus = /** @type {HTMLElement} */ (
    ui.element.querySelector('.car-workflow-launcher [aria-live="polite"]')
  );
  assert.equal(workflowStatus.dataset.state, 'warning');
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR disposal during a pending connection closes the late session without mounting UI', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  /** @type {(result: Awaited<ReturnType<typeof fixture.port.watch>>) => void} */
  let resolveWatch = () => {};
  const pendingWatch = new Promise((resolve) => {
    resolveWatch = resolve;
  });
  let closed = false;
  let watching = false;
  /** @type {import('@slop-lab/part/reference/index.js').Client.Port} */
  const pendingPort = {
    ...fixture.port,
    watch() {
      watching = true;
      return pendingWatch;
    },
  };
  const ui = createCarUi({
    document: window.document,
    baseUrl: 'https://car.test/',
    portFactory: () => pendingPort,
  });
  window.document.body.append(ui.element);
  /** @type {HTMLFormElement} */ (
    ui.element.querySelector('[data-car-part="connection"]')
  ).requestSubmit();
  await until(() => watching);
  const disposal = ui.dispose();
  resolveWatch({
    ok: true,
    value: {
      bootstrap: {
        epoch: 'test',
        streamId: 'late',
        throughSequence: 0,
        cursor: 'late:0',
        audienceRevision: '1',
        items: [],
        streamingParts: [],
        capabilities: { revision: '1', entries: [] },
      },
      frames: { async *[Symbol.asyncIterator]() {} },
      async close() {
        closed = true;
      },
    },
  });
  await disposal;
  await delay(0);
  assert.equal(closed, true);
  assert.equal(ui.element.querySelector('[aria-label="Agent chat"]'), null);
  assert.equal(ui.element.isConnected, false);
  window.happyDOM.cancelAsync();
});

test('CAR permits retry after an invalid token connection failure', async () => {
  const window = createWindow();
  const successful = fakePort({ 'car.run/list': [] });
  let attempts = 0;
  /** @type {import('@slop-lab/part/reference/index.js').Client.Port} */
  const denied = {
    ...successful.port,
    async watch() {
      return {
        ok: false,
        error: {
          code: 'auth',
          category: /** @type {const} */ ('permission'),
          message: 'Unauthorized',
          retry: /** @type {const} */ ('never'),
        },
      };
    },
  };
  const ui = createCarUi({
    document: window.document,
    baseUrl: 'https://car.test/',
    portFactory: () => (++attempts === 1 ? denied : successful.port),
  });
  window.document.body.append(ui.element);
  const form = /** @type {HTMLFormElement} */ (
    ui.element.querySelector('[data-car-part="connection"]')
  );
  const token = /** @type {HTMLInputElement} */ (form.elements.namedItem('token'));
  token.value = 'invalid';
  form.requestSubmit();
  await until(() => ui.element.textContent.includes('Unauthorized'));
  token.value = 'valid';
  form.requestSubmit();
  await until(() => ui.element.querySelector('[data-car-state="connected"]') !== null);
  assert.equal(attempts, 2);
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

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
  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="workflows"]')).click();
  await until(() => ui.element.textContent.includes('review'));
  const form = /** @type {HTMLFormElement} */ (
    ui.element.querySelector('[data-car-query="workflow-start"]')
  );
  const input = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('input'));
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
  /** @type {HTMLButtonElement} */ (
    ui.element.querySelector('[data-car-action="workflow-cancel"]')
  ).click();
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
  /** @type {readonly (readonly [import('@slop-lab/part/reference/index.js').Client.CommandDelivery, string])[]} */
  const cases = [
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
    /** @type {HTMLButtonElement} */ (
      ui.element.querySelector('[data-car-tab="workflows"]')
    ).click();
    await until(() => ui.element.textContent.includes('one'));
    /** @type {HTMLFormElement} */ (
      ui.element.querySelector('[data-car-query="workflow-start"]')
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
  /** @type {import('@slop-lab/part/reference/index.js').Projection.Item} */
  const workflow = {
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
  const response = /** @type {HTMLTextAreaElement} */ (
    ui.element.querySelector('textarea[aria-label="JSON input for part.workflow/respond"]')
  );
  response.value = '{"ticketId":"approval","revision":"3","response":true}';
  response.dispatchEvent(new window.Event('input'));
  /** @type {HTMLFormElement} */ (response.closest('form')).requestSubmit();
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
  /** @type {(result: import('@slop-lab/part/reference/index.js').Contracts.Result<import('@slop-lab/part/reference/index.js').Contracts.Json>) => void} */
  let resolveDefinitions = () => {};
  const definitions = new Promise((resolve) => {
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
  /** @type {HTMLButtonElement} */ (ui.element.querySelector('[data-car-tab="workflows"]')).click();
  await until(() => requested);
  const launcher = /** @type {HTMLElement} */ (
    ui.element.querySelector('[data-car-query="workflow-start"]')?.closest('section')
  );
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

test('buildCarUi emits the same-origin static handoff without external assets', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'car-ui-'));
  try {
    const outputs = await buildCarUi({ outputDirectory });
    assert.deepEqual(
      outputs.map((path) => path.split('/').at(-1)),
      ['index.html', 'app.js', 'app.css'],
    );
    const html = await readFile(join(outputDirectory, 'index.html'), 'utf8');
    const script = await readFile(join(outputDirectory, 'app.js'), 'utf8');
    const styles = await readFile(join(outputDirectory, 'app.css'), 'utf8');
    assert.match(html, /<script[^>]+app\.js/);
    assert.match(html, /<link[^>]+app\.css/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(script, /node:sqlite|packages\/node|packages\/plugins/);
    assert.match(styles, /word-break:\s*keep-all/);
    assert.match(styles, /\.car-inspector-status\[data-state='success'\]/);
    assert.match(styles, /\.car-workflow-form\s*\{[^}]*display:\s*grid/s);
    assert.match(styles, /\.car-workflow-actions/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
