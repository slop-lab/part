import type { Client } from '../reference/client.js';
import type { Contracts } from '../reference/contracts.js';
import type { Projection } from '../reference/projection.js';
import type { UI } from '../reference/ui.js';
import { orderSlots } from './registry.js';
export interface ArtifactReader {
  read(
    ref: Contracts.ArtifactRef,
  ): Promise<Contracts.Result<{ bytes: Uint8Array; mediaType: string; name?: string }>>;
}
export function createArtifactPreview(
  ref: Contracts.ArtifactRef,
  reader: ArtifactReader,
  document: Document,
  maxBytes = 16 * 1024 * 1024,
): { element: HTMLElement; dispose(): void } {
  const element = document.createElement('section'),
    button = document.createElement('button'),
    status = document.createElement('pre');
  button.type = 'button';
  button.textContent = 'Load artifact';
  status.textContent = `Artifact ${ref.id}`;
  element.append(button, status);
  let disposed = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    void reader
      .read(ref)
      .then((result) => {
        if (disposed) return;
        if (!result.ok) {
          status.textContent = result.error.message;
          return;
        }
        const value = result.value;
        if (value.bytes.length > maxBytes) {
          status.textContent = 'Artifact exceeds viewer size limit';
          return;
        }
        // Bytes are never interpreted as HTML, SVG, scripts or an embedded document.
        if (/^(text\/|application\/json(?:;|$))/.test(value.mediaType)) {
          try {
            status.textContent = new TextDecoder('utf-8', { fatal: true }).decode(value.bytes);
          } catch {
            status.textContent = 'Artifact text is not valid UTF-8';
          }
        } else
          status.textContent = `${value.name ?? 'Binary artifact'} · ${value.mediaType} · ${value.bytes.length} bytes`;
      })
      .catch(() => {
        if (!disposed) status.textContent = 'Artifact unavailable';
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return {
    element,
    dispose() {
      disposed = true;
      element.remove();
    },
  };
}
export function createInspector(options: {
  client: Client.Controller;
  document?: Document;
  renderers?: readonly UI.Renderer<Contracts.Json, HTMLElement>[];
  slots?: readonly UI.SlotContribution<HTMLElement>[];
  artifacts?: ArtifactReader;
  selected?: string;
  ownsClient?: boolean;
  className?: string;
}): { element: HTMLElement; select(id: string): void; dispose(): Promise<void> } {
  const document = options.document ?? globalThis.document,
    client = options.client;
  const ordered = orderSlots(options.slots ?? []);
  if (!ordered.ok) throw new Error(ordered.error.message);
  const slots = ordered.value;
  if (slots.some((slot) => !['inspector.tabs', 'artifact.preview'].includes(slot.slot)))
    throw new Error('Unsupported inspector slot');
  const root = document.createElement('aside'),
    select = document.createElement('select'),
    content = document.createElement('div');
  root.className = ['part-ui', options.className].filter(Boolean).join(' ');
  root.setAttribute('aria-label', 'Inspector');
  select.setAttribute('aria-label', 'Inspected item');
  root.append(select, content);
  let selected = options.selected,
    shown: Projection.Item | undefined;
  const previews: ReturnType<typeof createArtifactPreview>[] = [];
  function render() {
    const items = client
      .getState()
      .itemIds.map((id) => client.getItem(id))
      .filter((item): item is Projection.Item => !!item);
    select.replaceChildren(
      ...items.map((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.fallback.label;
        return option;
      }),
    );
    if (!items.some((item) => item.id === selected)) selected = items[0]?.id;
    select.value = selected ?? '';
    const item = selected ? client.getItem(selected) : undefined;
    if (item === shown) return;
    shown = item;
    for (const preview of previews.splice(0)) preview.dispose();
    content.replaceChildren();
    if (!item) return;
    const context = { controller: client, target: 'inspector', itemId: item.id };
    const renderer = options.renderers?.find(
      (r) =>
        r.target === 'inspector' &&
        r.type === item.type &&
        r.schemaVersions.includes(item.schemaVersion),
    );
    let body: HTMLElement | undefined;
    try {
      body = renderer?.render(item, context);
    } catch {}
    if (!body) {
      body = document.createElement('pre');
      body.textContent = `${item.fallback.label}\n${item.fallback.text ?? ''}\n${JSON.stringify(item.payload, null, 2)}`;
    }
    content.append(body);
    for (const slot of slots.filter((slot) => slot.slot === 'inspector.tabs')) {
      try {
        content.append(slot.render(context));
      } catch {}
    }
    for (const ref of item.artifacts) {
      if (options.artifacts) {
        const preview = createArtifactPreview(ref, options.artifacts, document);
        previews.push(preview);
        content.append(preview.element);
      }
      for (const slot of slots.filter((slot) => slot.slot === 'artifact.preview')) {
        try {
          content.append(slot.render(context));
        } catch {}
      }
    }
  }
  select.addEventListener('change', () => {
    selected = select.value;
    render();
  });
  const unsubscribe = client.subscribe({ select: (state) => state, equal: () => false }, render);
  render();
  return {
    element: root,
    select(id) {
      selected = id;
      render();
    },
    async dispose() {
      unsubscribe();
      for (const preview of previews) preview.dispose();
      root.remove();
      if (options.ownsClient) await client.dispose();
    },
  };
}
