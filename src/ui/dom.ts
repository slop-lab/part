import type { Client } from '../reference/client.js';
import type { Contracts } from '../reference/contracts.js';
import type { Projection } from '../reference/projection.js';
import type { UI } from '../reference/ui.js';
import { createComposer, createScroll } from './headless.js';
import { createMarkdownView } from './markdown.js';
import { orderSlots } from './registry.js';
export interface ChatComponents {
  Message(item: Projection.Item, context: UI.RenderContext, body: HTMLElement): HTMLElement;
  Fallback(item: Projection.Item, context: UI.RenderContext): HTMLElement;
  ToolDetails(item: Projection.Item, context: UI.RenderContext): HTMLElement;
  Composer(context: {
    document: Document;
    form: HTMLFormElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    composer: UI.ComposerController;
    submit(): Promise<void>;
  }): HTMLElement;
}
export interface ChatOptions extends Omit<UI.ChatOptions<HTMLElement>, 'components'> {
  readonly components?: Partial<ChatComponents>;
  readonly document?: Document;
  readonly client: Client.Controller & {
    getPart?(itemId: string, partId: string): Client.StreamPartSnapshot | undefined;
  };
  readonly command?: (draft: UI.Draft) => Contracts.CommandRequest;
  readonly maxVisibleItems?: number;
}
export interface ChatView {
  readonly element: HTMLElement;
  readonly composer: UI.ComposerController;
  dispose(): Promise<void>;
}
export function createChat(options: ChatOptions): ChatView {
  const ordered = orderSlots(options.slots ?? []);
  if (!ordered.ok) throw new TypeError(ordered.error.message);
  if (
    ordered.value.some(
      (slot) => !['composer.actions', 'message.actions', 'artifact.preview'].includes(slot.slot),
    )
  )
    throw new TypeError('Unsupported Chat slot position');
  const document = options.document ?? globalThis.document,
    controller = options.client;
  const root = document.createElement('section');
  root.className = ['part-ui', options.className].filter(Boolean).join(' ');
  root.setAttribute('aria-label', 'Agent chat');
  for (const [key, value] of Object.entries(options.theme ?? {}))
    root.style.setProperty(`--part-${key}`, value);
  const thread = document.createElement('div');
  thread.dataset.partPart = 'thread';
  thread.setAttribute('role', 'log');
  thread.setAttribute('aria-label', 'Conversation');
  thread.tabIndex = 0;
  const status = document.createElement('p');
  status.dataset.partPart = 'status';
  status.setAttribute('aria-live', 'polite');
  const form = document.createElement('form'),
    textarea = document.createElement('textarea');
  textarea.dataset.partPart = 'composer';
  textarea.setAttribute('aria-label', 'Message');
  textarea.placeholder = 'Write a message…';
  textarea.rows = 3;
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = 'Send';
  const follow = document.createElement('button');
  follow.type = 'button';
  follow.textContent = 'New messages ↓';
  follow.hidden = true;
  const older = document.createElement('button');
  older.type = 'button';
  older.textContent = 'Show earlier messages';
  older.hidden = true;
  root.append(older, thread, follow, status, form);
  form.append(textarea, send);
  const composer = createComposer({
      invoke: (request) => controller.invoke(request),
      command:
        options.command ??
        ((draft) => {
          const commandId = crypto.randomUUID();
          return {
            protocolVersion: 1,
            commandId,
            idempotencyKey: commandId,
            actionId: 'part.run/start',
            actionVersion: 1,
            input: draft.text,
          };
        }),
    }),
    scroll = createScroll();
  const renderers = new Map<string, UI.Renderer<Contracts.Json, HTMLElement>>();
  for (const renderer of options.renderers ?? [])
    for (const version of renderer.schemaVersions) {
      const key = `${renderer.target}/${renderer.type}@${version}`;
      if (renderers.has(key)) throw new Error(`Duplicate renderer ${key}`);
      renderers.set(key, renderer);
    }
  const rendered = new Map<string, { item: Projection.Item; element: HTMLElement }>();
  let visible = options.maxVisibleItems ?? 100,
    disposed = false;
  const markdownViews = new WeakMap<HTMLElement, ReturnType<typeof createMarkdownView>>();
  const updateMessageText = (element: HTMLElement, text: string) => {
    const body = element.matches('[data-part-part="message-body"]')
      ? element
      : element.querySelector<HTMLElement>('[data-part-part="message-body"]');
    const view = body && markdownViews.get(body);
    if (view) view.update(text);
    else {
      const pre = element.querySelector('pre');
      if (pre) pre.textContent = text;
    }
  };
  const fallback = (item: Projection.Item): HTMLElement => {
    if (options.components?.Fallback) {
      try {
        return options.components.Fallback(item, { controller, target: 'chat', itemId: item.id });
      } catch {}
    }
    const node = document.createElement('div');
    node.dataset.partPart = 'message-body';
    const label = document.createElement('strong');
    label.textContent = item.fallback.label;
    const text = createMarkdownView(document);
    text.update(item.fallback.text ?? '');
    markdownViews.set(node, text);
    node.append(label, text.element);
    for (const action of item.actions) {
      if (action.availability.state !== 'available' || action.input.id !== 'part/null') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.id;
      button.addEventListener('click', () => {
        void controller.invoke({
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          actionId: action.id,
          actionVersion: action.version,
          ...(item.source ? { target: item.source } : {}),
          input: null,
        });
      });
      node.append(button);
    }
    return node;
  };
  const render = () => {
    if (disposed) return;
    const state = controller.getState(),
      ids = state.itemIds.slice(-visible),
      available = new Set(ids);
    for (const [id, entry] of rendered)
      if (!available.has(id)) {
        entry.element.remove();
        rendered.delete(id);
      }
    for (const id of ids) {
      const item = controller.getItem(id);
      if (!item) continue;
      const existing = rendered.get(id);
      const streamed = options.client.getPart?.(id, 'text');
      if (existing?.item === item) {
        if (
          streamed &&
          !(item.payload && typeof item.payload === 'object' && 'phase' in item.payload)
        )
          updateMessageText(existing.element, streamed.text);
        continue;
      }
      let body: HTMLElement;
      try {
        const renderer = renderers.get(`chat/${item.type}@${item.schemaVersion}`);
        body = renderer
          ? renderer.render(item, { controller, target: 'chat', itemId: id })
          : item.type === 'part/tool' && options.components?.ToolDetails
            ? options.components.ToolDetails(item, { controller, target: 'chat', itemId: id })
            : fallback(item);
      } catch {
        body = fallback(item);
      }
      if (
        streamed &&
        item.type === 'part/message' &&
        !(item.payload && typeof item.payload === 'object' && 'phase' in item.payload)
      ) {
        updateMessageText(body, streamed.text);
      }
      let message: HTMLElement;
      try {
        message = options.components?.Message
          ? options.components.Message(item, { controller, target: 'chat', itemId: id }, body)
          : document.createElement('article');
      } catch {
        message = document.createElement('article');
      }
      message.dataset.partPart = 'message';
      message.dataset.partType = item.type;
      message.dataset.state =
        typeof item.payload === 'object' &&
        item.payload &&
        !Array.isArray(item.payload) &&
        'phase' in item.payload
          ? String(item.payload.phase)
          : 'ready';
      if (!message.contains(body)) message.append(body);
      for (const slot of ordered.value.filter(
        (slot) =>
          slot.slot === 'message.actions' ||
          (slot.slot === 'artifact.preview' && item.artifacts.length),
      )) {
        try {
          message.append(slot.render({ controller, target: 'chat', itemId: id }));
        } catch {
          /* Isolate an optional presentation failure. */
        }
      }
      if (existing) existing.element.replaceWith(message);
      else thread.append(message);
      rendered.set(id, { item, element: message });
    }
    // Preserve requested order without reconstructing unchanged message bodies.
    for (const id of ids) {
      const entry = rendered.get(id);
      if (entry) thread.append(entry.element);
    }
    status.textContent = state.connection;
    older.hidden = state.itemIds.length <= visible;
    scroll.contentChanged();
    follow.hidden = !scroll.getState().hasNewContent;
    if (scroll.getState().following) thread.scrollTop = thread.scrollHeight;
  };
  const unsubscribe = controller.subscribe(
    {
      select: (state) => ({ state, items: state.itemIds.map((id) => controller.getItem(id)) }),
      equal: () => false,
    },
    render,
  );
  const submit = async () => {
    send.disabled = true;
    try {
      const delivery = await composer.submit('button');
      textarea.value = composer.getDraft().text;
      if (delivery.kind === 'unknown')
        status.textContent = 'Delivery unknown. Check command status before retrying.';
      else if (delivery.kind === 'not-sent') status.textContent = delivery.error.message;
      else if (delivery.receipt.kind === 'rejected' || delivery.receipt.kind === 'failed')
        status.textContent = delivery.receipt.error.message;
      textarea.focus();
    } finally {
      send.disabled = false;
    }
  };
  textarea.addEventListener('input', () => {
    const draft = composer.getDraft();
    composer.setDraft({ ...draft, text: textarea.value });
  });
  textarea.addEventListener('compositionstart', () => composer.setComposing(true));
  textarea.addEventListener('compositionend', () => composer.setComposing(false));
  textarea.addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      composer.canSubmit().allowed
    ) {
      event.preventDefault();
      void submit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  thread.addEventListener('scroll', () => {
    scroll.onUserScroll(thread.scrollHeight - thread.clientHeight - thread.scrollTop);
    follow.hidden = !scroll.getState().hasNewContent;
  });
  follow.addEventListener('click', () => {
    scroll.followLatest();
    thread.scrollTop = thread.scrollHeight;
    follow.hidden = true;
  });
  older.addEventListener('click', () => {
    visible += options.maxVisibleItems ?? 100;
    render();
  });
  for (const contribution of ordered.value.filter((slot) => slot.slot === 'composer.actions'))
    form.append(contribution.render({ controller, target: 'chat', itemId: '' }));
  if (options.components?.Composer) {
    const element = options.components.Composer({
      document,
      form,
      input: textarea,
      send,
      composer,
      submit,
    });
    if (element !== form) {
      form.replaceWith(element);
      if (!element.contains(form)) element.append(form);
    }
  }
  render();
  return {
    element: root,
    composer,
    async dispose() {
      if (!disposed) {
        disposed = true;
        unsubscribe();
        root.remove();
        if (options.ownsClient) await controller.dispose();
      }
    },
  };
}
