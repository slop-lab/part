// @ts-check
import { decodeArtifact, diffView, fileView, jsonView, textBlock } from './render.mjs';

/** @type {readonly (readonly [string, string, string])[]} */
const TABS = [
  ['runs', 'Runs', 'car.run/list'],
  ['workflows', 'Workflows', ''],
  ['history', 'History', 'car.history/path'],
  ['context', 'Context', 'car.context/get'],
  ['requests', 'Requests', 'car.request/get'],
  ['events', 'Events', 'car.events/get'],
  ['workspace', 'Workspace', 'car.workspace/read'],
  ['diff', 'Diff', 'car.workspace/diff'],
  ['artifact', 'Artifact', 'car.artifact/read'],
  ['items', 'Items', ''],
];

/** @typedef {import('@slop-lab/part/reference/index.js').Client.Port} Port */

/** @param {Document} document @param {string} tab */
function queryForm(document, tab) {
  const form = document.createElement('form');
  form.dataset.carQuery = tab;
  form.className = 'car-query-form';
  /** @type {readonly (readonly [string, string])[]} */
  const fields =
    tab === 'artifact'
      ? [
          ['store', 'Artifact store'],
          ['id', 'Artifact ID'],
        ]
      : [[tab === 'runs' ? 'run' : 'path', tab === 'runs' ? 'Run ID' : 'Workspace path']];
  for (const [name, labelText] of fields) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.name = name;
    input.autocomplete = 'off';
    label.textContent = labelText;
    label.append(input);
    form.append(label);
  }
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Load';
  form.append(button);
  return form;
}

/** @param {{document: Document, port: Port, itemInspector: HTMLElement,
 * workflow: {element: HTMLElement, refresh(): Promise<void>, dispose(): void}}} options */
export function createCarInspector(options) {
  const { document, port } = options;
  const root = document.createElement('section');
  root.className = 'car-inspector part-ui';
  root.setAttribute('aria-label', 'CAR inspector');
  const header = document.createElement('div');
  header.className = 'car-inspector-header';
  const heading = document.createElement('h2');
  heading.textContent = 'Inspector';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.dataset.carAction = 'refresh';
  refresh.textContent = 'Refresh';
  header.append(heading, refresh);
  const tabs = document.createElement('div');
  tabs.className = 'car-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Inspector views');
  const panel = document.createElement('div');
  panel.className = 'car-inspector-panel';
  panel.id = 'car-inspector-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.tabIndex = 0;
  const status = document.createElement('p');
  status.className = 'car-inspector-status';
  status.setAttribute('aria-live', 'polite');
  status.dataset.state = 'idle';
  root.append(header, tabs, status, panel);
  let active = 'runs';
  let trace = 'metadata';
  let disposed = false;
  let revision = 0;

  /** @param {string} text @param {'idle'|'loading'|'success'|'warning'|'error'} state */
  function setStatus(text, state) {
    status.textContent = text;
    status.dataset.state = state;
  }

  /** @param {string} queryId @param {import('@slop-lab/part/reference/index.js').Contracts.Json} input
   * @param {string=} tab */
  async function query(queryId, input, tab = active) {
    const current = ++revision;
    const requestedTab = tab;
    setStatus('Loading…', 'loading');
    refresh.disabled = true;
    const result = await port.query({ queryId, version: 1, input });
    if (disposed || current !== revision || requestedTab !== active) return;
    refresh.disabled = false;
    panel.replaceChildren();
    if (!result.ok) {
      setStatus(`Permission or query error: ${result.error.message}`, 'error');
      panel.append(textBlock(document, `${result.error.code}\n${result.error.message}`));
      return;
    }
    setStatus('Updated', 'success');
    render(requestedTab, result.value);
  }

  /** @param {string} tab @param {unknown} value */
  function render(tab, value) {
    panel.replaceChildren();
    if (tab === 'workspace') panel.append(fileView(document, value));
    else if (tab === 'diff') {
      const content =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (/** @type {Record<string, unknown>} */ (value).content) === 'string'
          ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (value).content)
          : typeof value === 'string'
            ? value
            : JSON.stringify(value, null, 2);
      panel.append(diffView(document, content));
    } else if (tab === 'artifact') {
      const record =
        value && typeof value === 'object' && !Array.isArray(value)
          ? /** @type {Record<string, unknown>} */ (value)
          : {};
      const decoded =
        record.encoding === 'base64' && typeof record.bytes === 'string'
          ? decodeArtifact(record.bytes)
          : { ok: false, message: 'Unsupported artifact encoding.' };
      const artifactText = decoded.ok
        ? (decoded.text ?? '')
        : (decoded.message ?? 'Artifact unavailable.');
      panel.append(textBlock(document, artifactText, 'car-artifact'));
    } else
      panel.append(
        jsonView(document, value, {
          metadataOnly: trace !== 'full' && (tab === 'context' || tab === 'requests'),
        }),
      );
  }

  /** @param {string} tab @param {boolean=} focus */
  function select(tab, focus = false) {
    revision++;
    active = tab;
    refresh.disabled = false;
    setStatus('', 'idle');
    for (const button of tabs.querySelectorAll('button')) {
      const selected = button.dataset.carTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    panel.replaceChildren();
    if (tab === 'items') panel.append(options.itemInspector);
    else if (tab === 'workflows') {
      panel.append(options.workflow.element);
      void options.workflow.refresh();
    } else if (['workspace', 'diff', 'artifact'].includes(tab))
      panel.append(queryForm(document, tab));
    else if (tab === 'runs') {
      panel.append(queryForm(document, tab));
      void refreshActive();
    } else void refreshActive();
  }

  async function refreshActive() {
    if (active === 'workflows') {
      await options.workflow.refresh();
      return;
    }
    const descriptor = TABS.find(([id]) => id === active);
    if (descriptor?.[2]) await query(descriptor[2], null);
  }

  TABS.forEach(([id, label], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.carTab = id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', panel.id);
    button.textContent = label;
    button.addEventListener('click', () => select(id));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? TABS.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      const descriptor = TABS[next];
      if (descriptor) select(descriptor[0], true);
      event.preventDefault();
    });
    tabs.append(button);
  });
  refresh.addEventListener('click', () => void refreshActive());
  panel.addEventListener('submit', (event) => {
    const form = event.target;
    const view = document.defaultView;
    if (!view || !(form instanceof view.HTMLFormElement)) return;
    event.preventDefault();
    const data = new view.FormData(form);
    if (active === 'workspace')
      void query('car.workspace/read', { path: String(data.get('path') ?? '') }, active);
    else if (active === 'diff')
      void query('car.workspace/diff', { path: String(data.get('path') ?? '') }, active);
    else if (active === 'artifact')
      void query(
        'car.artifact/read',
        {
          store: String(data.get('store') ?? ''),
          id: String(data.get('id') ?? ''),
        },
        active,
      );
    else if (active === 'runs') void query('car.run/get', String(data.get('run') ?? ''), active);
  });
  void port.query({ queryId: 'car.config/get', version: 1, input: null }).then((result) => {
    if (
      result.ok &&
      result.value &&
      typeof result.value === 'object' &&
      !Array.isArray(result.value)
    ) {
      const mode = /** @type {Record<string, unknown>} */ (result.value).trace;
      if (mode === 'full' || mode === 'metadata') trace = mode;
    }
  });
  select('runs');
  return {
    element: root,
    dispose() {
      disposed = true;
      revision++;
      options.workflow.dispose();
      root.remove();
    },
  };
}
