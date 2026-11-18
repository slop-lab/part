// @ts-check
import { createCarUi } from '../car/ui/app.mjs';
import { Window } from 'happy-dom';

export const delay = /** @param {number} ms */ (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createWindow() {
  return /** @type {globalThis.Window & typeof globalThis & {happyDOM: import('happy-dom').Window['happyDOM']}} */ (
    /** @type {unknown} */ (new Window({ url: 'https://car.test/' }))
  );
}

/** @param {() => boolean} predicate */
export async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error('Timed out waiting for CAR UI state');
}

/** @param {Record<string, import('@slop-lab/part/reference/index.js').Contracts.Json>} values
 * @param {{items?: readonly import('@slop-lab/part/reference/index.js').Projection.Item[],
 * deliveries?: import('@slop-lab/part/reference/index.js').Client.CommandDelivery[]}=} options */
export function fakePort(values, options = {}) {
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
export async function connectedUi(window, fixture) {
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
