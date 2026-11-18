/** A safe bounded Markdown subset. Raw HTML is always text; no executable URLs. */
export function createMarkdownView(document: Document): {
  element: HTMLElement;
  update(text: string): void;
} {
  const element = document.createElement('div');
  element.dataset.partPart = 'markdown';
  const previous: { source: string; element: HTMLElement }[] = [];
  let lastText = '';
  let stableCount = 0;
  let stableOffset = 0;
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
  function blocks(text: string, start: number) {
    const result: { source: string; through?: number }[] = [];
    let lines: string[] = [];
    let fence = false;
    let offset = start;
    const newlines = /\r?\n/g;
    newlines.lastIndex = start;
    function add(line: string, through?: number) {
      if (line.startsWith('```')) fence = !fence;
      if (!fence && !line.trim()) {
        if (lines.length) result.push({ source: lines.join('\n'), through });
        lines = [];
      } else lines.push(line);
    }
    for (const newline of text.matchAll(newlines)) {
      add(text.slice(offset, newline.index), newline.index + newline[0].length);
      offset = newline.index + newline[0].length;
    }
    add(text.slice(offset));
    if (lines.length) result.push({ source: lines.join('\n') });
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
      if (text === lastText) return;
      if (!text.startsWith(lastText)) {
        stableCount = 0;
        stableOffset = 0;
      }
      const tail = blocks(text, stableOffset);
      const first = stableCount;
      for (const [offset, block] of tail.entries()) {
        const index = first + offset;
        const existing = previous[index];
        if (existing?.source !== block.source) {
          const node = render(block.source);
          if (existing) existing.element.replaceWith(node);
          else element.append(node);
          previous[index] = { source: block.source, element: node };
        }
        if (block.through !== undefined) {
          stableCount = index + 1;
          stableOffset = block.through;
        }
      }
      for (const removed of previous.splice(first + tail.length)) removed.element.remove();
      lastText = text;
    },
  };
}
