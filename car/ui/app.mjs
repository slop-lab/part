// @ts-check
import { createChat } from '@slop-lab/part-browser/dom.js';
import { createInspector } from '@slop-lab/part-browser/inspector.js';
import { createController } from '@slop-lab/part/client/index.js';
import { createHttpPort } from '@slop-lab/part/client/http.js';
import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import { createCarInspector } from './inspector.mjs';
import { createWorkflowLauncher } from './workflow-launcher.mjs';
import { createWorkflowRenderer } from './workflow-renderer.mjs';

/** @typedef {import('@slop-lab/part/reference/index.js').Client.Port} Port */
/** @typedef {{headers?: () => Readonly<Record<string, string>>, fetch?: typeof fetch}} PortOptions */
/** @typedef {{document?: Document, baseUrl?: string, fetch?: typeof fetch,
 * portFactory?: (url: string, options: PortOptions) => Port}} CarUiOptions */

/** @param {Document} document @param {string} tag @param {string=} text */
function node(document, tag, text) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}

/** @param {string} encoded */
function bytes(encoded) {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** @param {CarUiOptions=} options */
export function createCarUi(options = {}) {
  const document = options.document ?? globalThis.document;
  const root = node(document, 'main');
  root.className = 'car-shell';
  const header = node(document, 'header');
  header.className = 'car-header';
  const identity = node(document, 'div');
  identity.className = 'car-identity';
  identity.append(
    node(document, 'p', 'PART / SOFTWARE ENGINEERING'),
    node(document, 'h1', 'CAR Workbench'),
  );
  const connection = node(document, 'form');
  connection.dataset.carPart = 'connection';
  connection.className = 'car-connection';
  const label = node(document, 'label', 'Bearer token');
  const token = /** @type {HTMLInputElement} */ (node(document, 'input'));
  token.name = 'token';
  token.type = 'password';
  token.autocomplete = 'off';
  token.spellcheck = false;
  label.append(token);
  const connect = /** @type {HTMLButtonElement} */ (node(document, 'button', 'Connect'));
  connect.type = 'submit';
  const status = node(document, 'p', 'Disconnected');
  status.className = 'car-connection-status';
  status.setAttribute('aria-live', 'polite');
  connection.append(label, connect, status);
  header.append(identity, connection);
  const body = node(document, 'div');
  body.className = 'car-workbench';
  const empty = node(document, 'section');
  empty.className = 'car-empty';
  empty.append(
    node(document, 'h2', 'Connect to the local CAR runtime'),
    node(
      document,
      'p',
      'The token stays in this browser tab and is sent only as an Authorization header.',
    ),
  );
  body.append(empty);
  root.append(header, body);
  let disposed = false;
  let generation = 0;
  /** @type {ReturnType<typeof createController> | undefined} */
  let controller;
  /** @type {ReturnType<typeof createChat> | undefined} */
  let chat;
  /** @type {ReturnType<typeof createInspector> | undefined} */
  let itemInspector;
  /** @type {ReturnType<typeof createCarInspector> | undefined} */
  let carInspector;

  async function disconnect() {
    carInspector?.dispose();
    carInspector = undefined;
    await Promise.all([chat?.dispose(), itemInspector?.dispose()]);
    chat = undefined;
    itemInspector = undefined;
    await controller?.dispose();
    controller = undefined;
  }

  connection.addEventListener('submit', (event) => {
    event.preventDefault();
    if (disposed) return;
    connect.disabled = true;
    status.textContent = 'Connecting…';
    status.dataset.carState = 'connecting';
    const suppliedToken = token.value;
    const current = ++generation;
    void (async () => {
      await disconnect();
      if (disposed || current !== generation) return;
      const baseUrl =
        options.baseUrl ?? new URL('/', document.location?.href ?? globalThis.location.href).href;
      const port = (options.portFactory ?? createHttpPort)(baseUrl, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        headers: () => {
          /** @type {Record<string, string>} */
          const headers = {};
          if (suppliedToken) headers.authorization = `Bearer ${suppliedToken}`;
          return headers;
        },
      });
      const candidate = createController(port);
      controller = candidate;
      const connected = await candidate.connect({ surface: 'car' });
      if (disposed || current !== generation) {
        await candidate.dispose();
        if (controller === candidate) controller = undefined;
        return;
      }
      if (!connected.ok) {
        await candidate.dispose();
        if (controller === candidate) controller = undefined;
        status.textContent = connected.error.message;
        status.dataset.carState = 'error';
        connect.disabled = false;
        return;
      }
      chat = createChat({
        client: candidate,
        document,
        renderers: [createWorkflowRenderer(document)],
        command: (draft) => {
          const commandId = crypto.randomUUID();
          return {
            protocolVersion: 1,
            commandId,
            idempotencyKey: commandId,
            actionId: 'part.run/start',
            actionVersion: 1,
            input: draft.text,
          };
        },
      });
      itemInspector = createInspector({
        client: candidate,
        document,
        artifacts: {
          async read(ref) {
            const result = await port.query({
              queryId: 'car.artifact/read',
              version: 1,
              input: { store: ref.store, id: ref.id },
            });
            if (!result.ok) return result;
            const value = result.value;
            if (
              !isJsonObject(value) ||
              value.encoding !== 'base64' ||
              typeof value.bytes !== 'string'
            )
              return fail('car.artifact', 'Unsupported artifact response');
            try {
              return ok({ bytes: bytes(value.bytes), mediaType: 'application/octet-stream' });
            } catch {
              return fail('car.artifact', 'Artifact payload is not valid base64');
            }
          },
        },
      });
      const workflow = createWorkflowLauncher({ document, client: candidate });
      carInspector = createCarInspector({
        document,
        port,
        itemInspector: itemInspector.element,
        workflow,
      });
      const chatPanel = node(document, 'section');
      chatPanel.className = 'car-chat-panel';
      chatPanel.append(node(document, 'h2', 'Conversation'), chat.element);
      body.replaceChildren(chatPanel, carInspector.element);
      token.value = '';
      status.textContent = 'Connected';
      status.dataset.carState = 'connected';
      connect.textContent = 'Reconnect';
      connect.disabled = false;
      chat.element.querySelector('textarea')?.focus();
    })().catch(() => {
      if (disposed || current !== generation) return;
      status.textContent = 'Connection failed. Check the local server and token.';
      status.dataset.carState = 'error';
      connect.disabled = false;
    });
  });

  return {
    element: root,
    async dispose() {
      disposed = true;
      generation++;
      await disconnect();
      root.remove();
    },
  };
}

if (globalThis.document) {
  const mount = document.getElementById('app');
  if (mount) mount.append(createCarUi().element);
}
