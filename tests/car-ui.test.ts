import { createCarUi } from '../car/ui/app.mjs';
import { buildCarUi } from '../car/scripts/build-ui.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectedUi, createWindow, delay, fakePort, until } from '../fixtures/car-ui.mjs';
import type { Client, Contracts } from '@slop-lab/part/reference/index.js';

test('CAR connects to the same origin with an in-memory bearer token and mounts shared Chat', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  const { ui, portUrl, portOptions } = await connectedUi(window, fixture);
  assert.equal(portUrl, 'https://car.test/');
  assert.deepEqual(portOptions?.headers?.(), { authorization: 'Bearer user-secret' });
  assert.ok(ui.element.querySelector('[aria-label="Agent chat"]'));
  assert.equal(ui.element.textContent.includes('user-secret'), false);
  assert.equal(window.localStorage.length, 0);
  const textarea = ui.element.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'inspect this repository';
  textarea.dispatchEvent(new window.Event('input'));
  (textarea.form as HTMLFormElement).requestSubmit();
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
  (ui.element.querySelector('[data-car-tab="context"]') as HTMLButtonElement).click();
  await until(() => ui.element.textContent.includes('abc'));
  assert.match(ui.element.textContent, /metadata-only/i);
  const before = fixture.queries.filter((query) => query.queryId === 'car.context/get').length;
  (ui.element.querySelector('[data-car-action="refresh"]') as HTMLButtonElement).click();
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

  const queryFixtures: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
    ['workspace', { path: 'src/file.js' }],
    ['diff', { path: 'src/file.js' }],
    ['artifact', { store: 'car', id: 'artifact-1' }],
  ];
  for (const [tab, fields] of queryFixtures) {
    (ui.element.querySelector(`[data-car-tab="${tab}"]`) as HTMLButtonElement).click();
    for (const [name, value] of Object.entries(fields))
      (ui.element.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
    (ui.element.querySelector(`[data-car-query="${tab}"]`) as HTMLFormElement).requestSubmit();
    await until(() => ui.element.textContent.includes(dangerous));
    assert.equal(ui.element.querySelector('script'), null);
  }

  (ui.element.querySelector('[data-car-tab="requests"]') as HTMLButtonElement).click();
  await until(() => ui.element.textContent.includes('Inspector access denied'));
  assert.match(ui.element.textContent, /permission/i);
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR ignores a delayed prior-tab query and clears its status when another tab is selected', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  let resolveDiff: (result: Contracts.Result<Contracts.Json>) => void = () => {};
  const delayedDiff = new Promise<Contracts.Result<Contracts.Json>>((resolve) => {
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
  (ui.element.querySelector('[data-car-tab="diff"]') as HTMLButtonElement).click();
  (ui.element.querySelector('[data-car-query="diff"]') as HTMLFormElement).requestSubmit();
  await until(() => requested);
  const status = ui.element.querySelector('.car-inspector-status') as HTMLElement;
  assert.equal(status.dataset.state, 'loading');
  (ui.element.querySelector('[data-car-tab="artifact"]') as HTMLButtonElement).click();
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
  (ui.element.querySelector('[data-car-tab="diff"]') as HTMLButtonElement).click();
  (ui.element.querySelector('[data-car-query="diff"]') as HTMLFormElement).requestSubmit();
  await until(() => ui.element.textContent.includes('Inspector access denied'));
  const status = ui.element.querySelector('.car-inspector-status') as HTMLElement;
  assert.equal(status.dataset.state, 'error');
  for (const tab of ['items', 'workflows']) {
    (ui.element.querySelector(`[data-car-tab="${tab}"]`) as HTMLButtonElement).click();
    assert.equal(status.textContent, '');
    assert.equal(status.dataset.state, 'idle');
  }
  await until(() => ui.element.textContent.includes('No workflow definition'));
  const workflowStatus = ui.element.querySelector(
    '.car-workflow-launcher [aria-live="polite"]',
  ) as HTMLElement;
  assert.equal(workflowStatus.dataset.state, 'warning');
  await ui.dispose();
  window.happyDOM.cancelAsync();
});

test('CAR disposal during a pending connection closes the late session without mounting UI', async () => {
  const window = createWindow();
  const fixture = fakePort({ 'car.run/list': [] });
  let resolveWatch: (result: Awaited<ReturnType<typeof fixture.port.watch>>) => void = () => {};
  const pendingWatch = new Promise<Awaited<ReturnType<typeof fixture.port.watch>>>((resolve) => {
    resolveWatch = resolve;
  });
  let closed = false;
  let watching = false;
  const pendingPort: Client.Port = {
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
  (ui.element.querySelector('[data-car-part="connection"]') as HTMLFormElement).requestSubmit();
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
  const denied: Client.Port = {
    ...successful.port,
    async watch() {
      return {
        ok: false,
        error: {
          code: 'auth',
          category: 'permission' as const,
          message: 'Unauthorized',
          retry: 'never' as const,
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
  const form = ui.element.querySelector('[data-car-part="connection"]') as HTMLFormElement;
  const token = form.elements.namedItem('token') as HTMLInputElement;
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
