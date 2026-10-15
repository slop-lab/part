/** A safe bounded Markdown subset. Raw HTML is always text; no executable URLs. */
export function createMarkdownView(document: Document): {
  element: HTMLElement;
  update(text: string): void;
} {
  const element = document.createElement('div');
  element.dataset.partPart = 'markdown';
  let previous: { source: string; element: HTMLElement }[] = [];
  function inline(parent: HTMLElement, text: string) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(offset, match.index)));
      const value = match[0];
      let child: HTMLElement;
      if (value.startsWith('`')) {
        child = document.createElement('code');
        child.textContent = value.slice(1, -1);
      } else if (value.startsWith('**')) {
        child = document.createElement('strong');
        child.textContent = value.slice(2, -2);
      } else if (value.startsWith('*')) {
        child = document.createElement('em');
        child.textContent = value.slice(1, -1);
      } else {
        const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value)!;
        const url = (() => {
          try {
            const url = new URL(parts[2]!);
            return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url : undefined;
          } catch {
            return undefined;
          }
        })();
        child = document.createElement(url ? 'a' : 'span');
        child.textContent = parts[1]!;
        if (url) {
          (child as HTMLAnchorElement).href = url.href;
          (child as HTMLAnchorElement).rel = 'noopener noreferrer';
        }
      }
      parent.append(child);
      offset = match.index! + value.length;
    }
    parent.append(document.createTextNode(text.slice(offset)));
  }
  function blocks(text: string): string[] {
    const result: string[] = [],
      current: string[] = [];
    let fence = false;
    for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
      if (line.startsWith('```')) fence = !fence;
      if (!fence && !line.trim()) {
        if (current.length) {
          result.push(current.join('\n'));
          current.length = 0;
        }
      } else current.push(line);
    }
    if (current.length) result.push(current.join('\n'));
    return result;
  }
  function render(source: string): HTMLElement {
    const lines = source.split('\n');
    if (source.startsWith('```')) {
      const pre = document.createElement('pre'),
        code = document.createElement('code');
      code.textContent = lines
        .slice(1, lines.at(-1)?.startsWith('```') ? -1 : undefined)
        .join('\n');
      code.dataset.language = lines[0]!.slice(3).trim();
      pre.append(code);
      return pre;
    }
    const heading = /^(#{1,6}) (.*)$/s.exec(source);
    if (heading) {
      const node = document.createElement(`h${heading[1]!.length}`);
      inline(node, heading[2]!);
      return node;
    }
    if (lines.every((line) => /^[-*] /.test(line))) {
      const list = document.createElement('ul');
      for (const line of lines) {
        const item = document.createElement('li');
        inline(item, line.slice(2));
        list.append(item);
      }
      return list;
    }
    const node = document.createElement(source.startsWith('> ') ? 'blockquote' : 'p');
    inline(
      node,
      source.startsWith('> ') ? lines.map((line) => line.replace(/^> ?/, '')).join('\n') : source,
    );
    return node;
  }
  return {
    element,
    update(text) {
      const next = blocks(text).map((source, index) =>
        previous[index]?.source === source ? previous[index]! : { source, element: render(source) },
      );
      // Completed blocks retain their DOM nodes; only changed blocks are reparsed.
      for (const entry of previous) if (!next.includes(entry)) entry.element.remove();
      for (const entry of next) element.append(entry.element);
      previous = next;
    },
  };
}
