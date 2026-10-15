// @ts-check
import { performance } from 'node:perf_hooks';
import { Window } from 'happy-dom';
import { createWatchHub, createLocalPort, createController } from '@slop-lab/part/client';
import { createChat } from '@slop-lab/part-browser/dom';
import { localContext, ok } from '@slop-lab/part/contracts';
const window =
    /** @type {globalThis.Window & typeof globalThis & { happyDOM: import('happy-dom').Window['happyDOM'] }} */ (
      /** @type {unknown} */ (new Window())
    ),
  context = localContext();
const items = Array.from({ length: 1000 }, (_, index) => ({
  id: `history/${index}`,
  type: 'benchmark/completed',
  schemaVersion: 1,
  revision: '1',
  payload: { text: `Completed message ${index}` },
  fallback: { label: 'Message', text: `Completed message ${index}` },
  actions: [],
  artifacts: [],
}));
items.push({
  id: 'live',
  type: 'part/message',
  schemaVersion: 1,
  revision: '1',
  payload: { text: '' },
  fallback: { label: 'Assistant', text: '' },
  actions: [],
  artifacts: [],
});
const hub = createWatchHub({ revision: '1', entries: [] }, items);
/** @type {import('@slop-lab/part/reference').Client.Endpoint} */
const endpoint = {
  watch: (_request, c) => hub.watch(c),
  query: async () => ok(null),
  command: async (request) => ({
    kind: 'rejected',
    commandId: request.commandId,
    error: {
      code: 'benchmark.unused',
      category: 'unsupported',
      message: 'No benchmark commands',
      retry: 'never',
    },
  }),
};
const client = createController(createLocalPort(endpoint, () => context));
let renderedCompleted = 0;
const start = performance.now();
await client.connect({ surface: 'chat' });
const view = createChat({
  client,
  document: window.document,
  maxVisibleItems: 100,
  renderers: [
    {
      id: 'benchmark/cache',
      type: 'benchmark/completed',
      schemaVersions: [1],
      target: 'chat',
      render(item) {
        renderedCompleted++;
        const node = window.document.createElement('pre');
        node.textContent = String(item.fallback.text);
        return node;
      },
    },
  ],
});
window.document.body.append(view.element);
const bootstrapMs = performance.now() - start;
const beforeRenders = renderedCompleted,
  stableNode = view.element.querySelector('article');
const updates = 200,
  streamStart = performance.now();
try {
  for (let index = 0; index < updates; index++) {
    hub.delta({
      itemId: 'live',
      partId: 'text',
      generation: 'benchmark',
      offset: index,
      text: 'x',
    });
    await new Promise(setImmediate);
  }
  const updateMs = performance.now() - streamStart;
  const result = {
    environment: 'Node/happy-dom; excludes browser layout/paint',
    historyItems: items.length,
    visibleItems: view.element.querySelectorAll('article').length,
    updates,
    bootstrapMs,
    updateMs,
    meanUpdateMs: updateMs / updates,
    completedRendererCallsDuringStream: renderedCompleted - beforeRenders,
    completedNodeRetained: stableNode === view.element.querySelector('article'),
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    result.completedRendererCallsDuringStream ||
    !result.completedNodeRetained ||
    result.visibleItems > 100 ||
    client.getPart('live', 'text').text.length !== updates
  )
    process.exitCode = 1;
} finally {
  await view.dispose();
  await client.dispose();
  hub.close();
  await window.happyDOM.close();
}
