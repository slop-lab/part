import { createChat } from '@part/browser/dom';
import { createController, createLocalPort, createWatchHub } from '@part/core/client';
import { fail, localContext, ok } from '@part/core/contracts';
import type { Client, Projection } from '@part/core/reference';
const context = localContext(),
  hub = createWatchHub({ revision: 'demo', entries: [] });
const runs = new Map<string, AbortController>();
const item = (id: string, label: string, text: string): Projection.Item => ({
  id,
  type: 'part/message',
  schemaVersion: 1,
  revision: '1',
  payload: { text },
  fallback: { label, text },
  actions: [],
  artifacts: [],
});
const endpoint: Client.Endpoint = {
  async command(request) {
    if (request.actionId === 'part.run/cancel') {
      const run = request.target && runs.get(request.target.id);
      run?.abort();
      return {
        kind: 'completed',
        commandId: request.commandId,
        result: { state: 'requested' },
        effect: 'not-applicable',
        commit: [],
      };
    }
    if (request.actionId !== 'part.run/start' || typeof request.input !== 'string')
      return {
        kind: 'rejected',
        commandId: request.commandId,
        error: fail('demo.action', 'Unsupported action').error,
      };
    const id = crypto.randomUUID(),
      abort = new AbortController(),
      ref = { owner: 'demo', kind: 'run', id };
    runs.set(id, abort);
    hub.upsert(item(`${id}/user`, 'You', request.input));
    hub.upsert({
      ...item(id, 'Assistant', ''),
      source: ref,
      actions: [
        {
          id: 'part.run/cancel',
          version: 1,
          input: { id: 'part/null', version: 1 },
          output: { id: 'part/json', version: 1 },
          execution: 'immediate',
          availability: { state: 'available', checkedAt: 'demo' },
        },
      ],
    });
    void (async () => {
      const text =
        'This is a simulated stream through the public client and Chat contracts. Replace the client port with your embedded or HTTP endpoint to connect part to a model.';
      let current = '';
      for (const word of text.split(' ')) {
        if (abort.signal.aborted) break;
        const delta = `${word} `;
        hub.delta({
          itemId: id,
          partId: 'text',
          generation: id,
          offset: current.length,
          text: delta,
        });
        current += delta;
        await new Promise((resolve) => setTimeout(resolve, 65));
      }
      const final = abort.signal.aborted ? `${current}\nCancelled` : current;
      hub.upsert({
        ...item(id, 'Assistant', final),
        revision: '2',
        payload: { phase: abort.signal.aborted ? 'cancelled' : 'completed', text: final },
      });
      hub.upsert({
        id: `${id}/report`,
        type: 'example/report-card',
        schemaVersion: 1,
        revision: '1',
        payload: { summary: 'Custom card extension', checks: 3 },
        fallback: { label: 'Report', text: 'Custom card extension · 3 checks' },
        actions: [],
        artifacts: [],
      });
      runs.delete(id);
    })();
    return { kind: 'accepted', commandId: request.commandId, operation: ref, commit: [] };
  },
  async query() {
    return ok(null);
  },
  async watch(_request, caller) {
    return hub.watch(caller);
  },
};
const controller = createController(
  createLocalPort(endpoint, () => context, { codecLoopback: true }),
);
void (async () => {
  await controller.connect({ surface: 'chat' });
  hub.upsert(
    item(
      'welcome',
      'part',
      'Progressive agent runtime. Try a message, cancel a stream, or switch the custom card renderer.',
    ),
  );
  const mount = document.querySelector('#chat')!,
    cards = document.querySelector<HTMLInputElement>('#cards')!,
    theme = document.querySelector<HTMLInputElement>('#theme')!;
  let view: ReturnType<typeof createChat>;
  const render = async () => {
    const draft = view?.composer.getDraft();
    await view?.dispose();
    view = createChat({
      client: controller,
      command: (draft) => ({
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        actionId: 'part.run/start',
        actionVersion: 1,
        input: draft.text,
      }),
      className: theme.checked ? 'alternate-theme' : '',
      renderers: cards.checked
        ? [
            {
              id: 'report',
              type: 'example/report-card',
              schemaVersions: [1],
              target: 'chat',
              render(item) {
                const card = document.createElement('div');
                card.className = 'report-card';
                const label = document.createElement('small');
                label.textContent = 'REPORT';
                const title = document.createElement('h3');
                title.textContent = 'Custom card extension';
                const text = document.createElement('p');
                text.textContent = '3 checks · typed payload · safe fallback available';
                card.append(label, title, text);
                return card;
              },
            },
          ]
        : [],
    });
    mount.replaceChildren(view.element);
    if (draft) {
      view.composer.setDraft(draft);
      view.element.querySelector('textarea')!.value = draft.text;
    }
  };
  await render();
  cards.addEventListener('change', () => {
    void render();
  });
  theme.addEventListener('change', () => {
    void render();
  });
})();
