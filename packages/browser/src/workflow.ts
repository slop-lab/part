import { isJson, isJsonObject } from '@part/core/contracts';
import type { Client, Contracts, Projection, UI } from '@part/core/reference';
export function createWorkflowView(options: {
  client: Client.Controller;
  document?: Document;
  ownsClient?: boolean;
  renderers?: readonly UI.Renderer<Contracts.Json, HTMLElement>[];
  className?: string;
  theme?: Readonly<Record<string, string>>;
}): { element: HTMLElement; dispose(): Promise<void> } {
  const document = options.document ?? globalThis.document,
    client = options.client;
  const root = document.createElement('section');
  root.className = ['part-ui', options.className].filter(Boolean).join(' ');
  root.setAttribute('aria-label', 'Workflows');
  for (const [key, value] of Object.entries(options.theme ?? {}))
    root.style.setProperty(`--part-${key}`, value);
  const list = document.createElement('div'),
    status = document.createElement('p');
  list.setAttribute('role', 'list');
  status.setAttribute('aria-live', 'polite');
  root.append(list, status);
  const drafts = new Map<
    string,
    { text: string; request?: Contracts.CommandRequest; busy: boolean }
  >();
  const rendered = new Map<string, { item: Projection.Item; element: HTMLElement }>();
  let disposed = false;
  function actionForm(
    item: Projection.Item,
    action: Contracts.ActionDescriptor,
    seed: Contracts.Json,
    key: string,
  ): HTMLElement {
    const draft = drafts.get(key) ?? { text: JSON.stringify(seed, null, 2), busy: false };
    drafts.set(key, draft);
    const form = document.createElement('form'),
      label = document.createElement('label'),
      input = document.createElement('textarea'),
      button = document.createElement('button');
    const inputId = `part-action-${crypto.randomUUID()}`;
    input.id = inputId;
    label.htmlFor = inputId;
    label.textContent = action.id;
    input.value = draft.text;
    input.setAttribute('aria-label', `JSON input for ${action.id}`);
    input.rows = 4;
    button.type = 'submit';
    button.textContent = 'Submit';
    button.disabled = draft.busy || action.availability.state !== 'available';
    input.addEventListener('input', () => {
      draft.text = input.value;
      draft.request = undefined;
    });
    form.append(label, input, button);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (draft.busy || action.availability.state !== 'available') return;
      let value: Contracts.Json;
      try {
        value = JSON.parse(input.value);
        if (!isJson(value)) throw new Error('Invalid JSON');
      } catch {
        status.textContent = 'Enter a valid JSON value.';
        return;
      }
      // Preserve the same command ID after unknown delivery. Editing creates a new command.
      draft.request ??= {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        actionId: action.id,
        actionVersion: action.version,
        ...(item.source ? { target: item.source } : {}),
        input: value,
      };
      draft.busy = true;
      button.disabled = true;
      status.textContent = 'Submitting…';
      void client
        .invoke(draft.request)
        .then((delivery) => {
          if (disposed) return;
          if (delivery.kind === 'receipt') {
            const receipt = delivery.receipt;
            status.textContent =
              receipt.kind === 'rejected' || receipt.kind === 'failed'
                ? receipt.error.message
                : 'Submitted';
            if (receipt.kind === 'accepted' || receipt.kind === 'completed')
              draft.request = undefined;
          } else
            status.textContent =
              delivery.kind === 'unknown'
                ? 'Delivery is unknown. Retry the same input to reconcile.'
                : 'Request was not sent.';
        })
        .catch(() => {
          if (!disposed)
            status.textContent = 'Delivery is unknown. Retry the same input to reconcile.';
        })
        .finally(() => {
          draft.busy = false;
          button.disabled = action.availability.state !== 'available';
        });
    });
    return form;
  }
  function fallback(item: Projection.Item): HTMLElement {
    const card = document.createElement('article');
    card.setAttribute('role', 'listitem');
    card.dataset.partPart = 'workflow';
    const title = document.createElement('h3'),
      content = document.createElement('pre');
    title.textContent = item.fallback.label;
    content.textContent = item.fallback.text ?? '';
    card.append(title, content);
    const payload = isJsonObject(item.payload) ? item.payload : undefined;
    if (item.type === 'part/workflow' && payload) {
      const phase = document.createElement('p');
      phase.textContent = `State: ${payload.phase} · effect: ${payload.effect}`;
      card.append(phase);
      if (payload.output !== undefined) {
        const output = document.createElement('pre');
        output.setAttribute('aria-label', 'Workflow result');
        output.textContent = JSON.stringify(payload.output, null, 2);
        card.append(output);
      }
    }
    for (const action of item.actions) {
      if (action.availability.state !== 'available') continue;
      if (action.id === 'part.workflow/respond' && Array.isArray(payload?.waits)) {
        for (const wait of payload.waits) {
          if (
            !isJsonObject(wait) ||
            !isJsonObject(wait.ticket) ||
            typeof wait.ticket.id !== 'string' ||
            typeof wait.ticket.revision !== 'string'
          )
            continue;
          const prompt = document.createElement('p');
          prompt.textContent =
            isJsonObject(wait.presentation) && typeof wait.presentation.prompt === 'string'
              ? wait.presentation.prompt
              : 'Response required';
          card.append(
            prompt,
            actionForm(
              item,
              action,
              { ticketId: wait.ticket.id, revision: wait.ticket.revision, response: null },
              `${item.id}/${wait.ticket.id}/${wait.ticket.revision}`,
            ),
          );
        }
      } else
        card.append(actionForm(item, action, null, `${item.id}/${action.id}@${action.version}`));
    }
    return card;
  }
  function render() {
    if (disposed) return;
    const items = client
      .getState()
      .itemIds.map((id) => client.getItem(id))
      .filter((item): item is Projection.Item => !!item);
    for (const [id, previous] of rendered)
      if (!items.some((item) => item.id === id)) {
        previous.element.remove();
        rendered.delete(id);
      }
    for (const item of items) {
      const prior = rendered.get(item.id);
      if (prior?.item === item) continue;
      const renderer = options.renderers?.find(
        (r) =>
          r.target === 'workflow' &&
          r.type === item.type &&
          r.schemaVersions.includes(item.schemaVersion),
      );
      let element: HTMLElement;
      try {
        element = renderer
          ? renderer.render(item, { controller: client, target: 'workflow', itemId: item.id })
          : fallback(item);
      } catch {
        element = fallback(item);
      }
      if (prior) prior.element.replaceWith(element);
      else list.append(element);
      rendered.set(item.id, { item, element });
    }
  }
  const unsubscribe = client.subscribe({ select: (state) => state, equal: () => false }, render);
  render();
  return {
    element: root,
    async dispose() {
      disposed = true;
      unsubscribe();
      root.remove();
      drafts.clear();
      rendered.clear();
      if (options.ownsClient) await client.disconnect();
    },
  };
}
