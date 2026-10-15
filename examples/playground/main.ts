import { createChat } from '@slop-lab/part-browser/dom';
import { createInspector } from '@slop-lab/part-browser/inspector';
import { createController } from '@slop-lab/part/client';
import { createHttpPort } from '@slop-lab/part/client/http';
import { fail, ok } from '@slop-lab/part/contracts';
import type { Contracts } from '@slop-lab/part/reference';
import catalog from './catalog.json' with { type: 'json' };
import { command, deliveryError, playgroundRenderers } from './renderers.js';

type Event = { kind: string; at: string; data: Contracts.Json };
type Run = {
  id: string;
  scenario: string;
  provider: string;
  phase: string;
  text: string;
  error: { code: string; message: string } | null;
  events: Event[];
};
type Session = { note: string; runs: Run[]; active: string | null };
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw Error(`Missing element ${id}`);
  return found as T;
}
const provider = element<HTMLSelectElement>('provider'),
  model = element<HTMLInputElement>('model'),
  notice = element('notice');
const controller = createController(createHttpPort(new URL('/api/', location.href).href));
let selected = catalog.find((entry) => entry.id === location.hash.slice(1)) ?? catalog[0]!;
let state: Session = { runs: [], active: null, note: '' },
  chat: ReturnType<typeof createChat>,
  polling = false,
  disposed = false;
const inspector = createInspector({
  client: controller,
  artifacts: {
    async read(ref) {
      try {
        const response = await fetch(`/api/artifacts/${encodeURIComponent(ref.id)}`);
        return response.ok
          ? ok({
              bytes: new Uint8Array(await response.arrayBuffer()),
              mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
            })
          : fail('playground.artifact', 'Artifact unavailable');
      } catch {
        return fail('playground.artifact', 'Artifact request failed');
      }
    },
  },
});
element('item-inspector').append(inspector.element);
function selectTab(tab: string) {
  for (const id of ['requests', 'events', 'note', 'items']) {
    element(`tab-${id}`).setAttribute('aria-selected', String(tab === id));
    element(`tab-${id}`).tabIndex = tab === id ? 0 : -1;
    element(`inspect-${id}`).hidden = tab !== id;
  }
}
for (const tab of ['requests', 'events', 'note', 'items']) {
  element(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
  element(`tab-${tab}`).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = ['requests', 'events', 'note', 'items'],
      index = tabs.indexOf(tab);
    const next =
      tabs[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? 3
            : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4
      ]!;
    selectTab(next);
    element(`tab-${next}`).focus();
    event.preventDefault();
  });
}
async function invoke(action: string, target?: Contracts.EntityRef) {
  const result = await controller.invoke(command(action, target));
  notice.textContent = deliveryError(result) ?? '';
  await refresh();
}
function setDraft(text: string) {
  chat.composer.setDraft({ text, references: [], revision: chat.composer.getDraft().revision + 1 });
  chat.element.querySelector('textarea')!.value = text;
}
async function renderChat() {
  const draft = chat?.composer.getDraft();
  await chat?.dispose();
  chat = createChat({
    client: controller,
    maxVisibleItems: 80,
    command: (draft) => ({
      ...command('part.run/start'),
      input: {
        prompt: draft.text,
        scenario: selected.id,
        provider: provider.value,
        ...(provider.value !== 'scripted' ? { model: model.value } : {}),
      },
    }),
    renderers: element<HTMLInputElement>('cards').checked
      ? playgroundRenderers(
          (action, target) => {
            void invoke(action, target);
          },
          (id) => {
            selectTab('items');
            inspector.select(id);
          },
        )
      : [],
    components: {
      Message(item, _context, body) {
        const article = document.createElement('article');
        article.className = item.fallback.label === 'You' ? 'user-message' : 'assistant-message';
        if (item.fallback.label === 'Assistant') {
          const mark = document.createElement('span');
          mark.className = 'assistant-mark';
          mark.textContent = 'p.';
          article.append(mark);
        }
        article.append(body);
        return article;
      },
    },
  });
  element('chat').replaceChildren(chat.element);
  if (draft) setDraft(draft.text);
  else setDraft(selected.prompt);
  chat.element.querySelector('textarea')!.placeholder = 'Ask something, or try the example above…';
}
function choose(id: string) {
  const next = catalog.find((entry) => entry.id === id);
  if (!next) return;
  selected = next;
  history.replaceState(null, '', `#${id}`);
  element('example-title').textContent = selected.title;
  element('breadcrumb').textContent = selected.title;
  element('example-tag').textContent = selected.tag;
  element('example-description').textContent = selected.description;
  element('expectation').textContent = selected.expected;
  for (const button of element('examples').querySelectorAll('button'))
    button.setAttribute('aria-current', String(button.dataset.scenario === id));
  if (chat) setDraft(selected.prompt);
  if (id === 'failure') {
    provider.value = 'scripted';
    providerChanged();
  }
}
for (const scenario of catalog) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.scenario = scenario.id;
  const number = document.createElement('span'),
    name = document.createElement('span'),
    tag = document.createElement('small');
  number.className = 'scenario-number';
  number.textContent = scenario.number;
  name.textContent = scenario.title;
  tag.textContent = scenario.tag;
  name.append(tag);
  button.append(number, name);
  button.addEventListener('click', () => choose(scenario.id));
  element('examples').append(button);
}
function providerChanged() {
  const scripted = provider.value === 'scripted';
  element('model-label').hidden = scripted;
  element('provider-hint').textContent = scripted
    ? 'No key. No network model calls.'
    : 'Live provider · requests use your configured account.';
  if (!scripted && selected.id === 'failure') choose('tools');
}
provider.addEventListener('change', providerChanged);
element('try-example').addEventListener('click', () => {
  if (state.active) return;
  setDraft(selected.prompt);
  chat.element.querySelector('form')!.requestSubmit();
});
element('cards').addEventListener('change', () => {
  void renderChat();
});
element('theme').addEventListener('change', () => {
  document.body.classList.toggle('dark', element<HTMLInputElement>('theme').checked);
});
element('stop').addEventListener('click', () => {
  if (state.active)
    void invoke('part.run/cancel', { owner: 'playground', kind: 'run', id: state.active });
});
element('clear').addEventListener('click', () => {
  void invoke('playground/clear');
});
const guide = element<HTMLDialogElement>('guide');
element('guide-open').addEventListener('click', () => guide.showModal());
element('guide-close').addEventListener('click', () => guide.close());
let renderedEvents = '';
function renderDetails() {
  const latest = state.runs.at(-1),
    events = latest?.events ?? [];
  element('turn-count').textContent =
    `${state.runs.length} ${state.runs.length === 1 ? 'run' : 'runs'}`;
  element<HTMLButtonElement>('stop').disabled = !state.active;
  element<HTMLButtonElement>('clear').disabled = !!state.active;
  element<HTMLButtonElement>('try-example').disabled = !!state.active;
  element('run-status').textContent = latest
    ? `${latest.phase} · ${latest.provider}`
    : 'Ready to explore';
  element('note-content').textContent = state.note || 'No note saved yet.';
  const key = JSON.stringify(events);
  if (key !== renderedEvents) {
    renderedEvents = key;
    const requests = events.filter((event) => event.kind === 'request');
    const target = element('inspect-requests');
    target.replaceChildren();
    if (!requests.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-inspector';
      empty.textContent = 'Run an example to inspect the model’s input, tools and request digest.';
      target.append(empty);
    }
    requests.forEach((event, index) => {
      const details = document.createElement('details'),
        summary = document.createElement('summary'),
        pre = document.createElement('pre');
      details.open = index === requests.length - 1;
      summary.textContent = `Request ${index + 1} · ${latest?.provider}`;
      pre.textContent = JSON.stringify(event.data, null, 2);
      details.append(summary, pre);
      target.append(details);
    });
    const eventView = element('inspect-events');
    eventView.replaceChildren();
    for (const event of events) {
      const details = document.createElement('details'),
        summary = document.createElement('summary'),
        pre = document.createElement('pre');
      summary.textContent = `${event.kind} · ${new Date(event.at).toLocaleTimeString()}`;
      pre.textContent = JSON.stringify(event.data, null, 2);
      details.append(summary, pre);
      eventView.append(details);
    }
  }
  if (latest?.error) notice.textContent = `${latest.error.code}: ${latest.error.message}`;
  else if (latest?.phase === 'completed' || latest?.phase === 'running') notice.textContent = '';
}
async function refresh() {
  if (polling || disposed) return;
  polling = true;
  try {
    const result = await controller.port.query({
      queryId: 'playground/state',
      version: 1,
      input: null,
    });
    if (result.ok) {
      state = result.value as unknown as Session;
      renderDetails();
    }
  } finally {
    polling = false;
  }
}
async function connect() {
  try {
    const result = await controller.connect({ surface: 'playground' });
    if (!result.ok) notice.textContent = result.error.message;
    await refresh();
  } catch {
    notice.textContent = 'Connection failed. Check the local server and choose Reconnect.';
  }
}
element('reconnect').addEventListener('click', () => {
  void connect();
});
controller.subscribe(
  { select: (current) => current.connection, equal: Object.is },
  (connection) => {
    element('connection').textContent = connection;
    element('connection').dataset.state = connection;
  },
);
void (async () => {
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw Error('Session unavailable');
    const config = (await response.json()) as {
      model: string;
      providers: { id: string; label: string; available: boolean }[];
    };
    for (const entry of config.providers) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label + (entry.available ? '' : ' · not configured');
      option.disabled = !entry.available;
      provider.append(option);
    }
    model.value = config.model;
    providerChanged();
    choose(selected.id);
    await renderChat();
    await connect();
  } catch {
    notice.textContent =
      'Could not open this session. Restart the local playground server and refresh.';
  }
})();
const timer = setInterval(() => {
  void refresh();
}, 500);
window.addEventListener('pagehide', () => {
  disposed = true;
  clearInterval(timer);
  void controller.dispose();
});
