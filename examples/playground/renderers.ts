import type { Client, Contracts, UI } from '@slop-lab/part/reference';

export function playgroundRenderers(
  invoke: (action: string, target?: Contracts.EntityRef) => void,
  inspect: (id: string) => void,
): UI.Renderer<Contracts.Json, HTMLElement>[] {
  return [
    {
      id: 'playground/approval',
      type: 'playground/approval',
      schemaVersions: [1],
      target: 'chat',
      render(item) {
        const card = document.createElement('section');
        card.className = 'approval-card';
        const heading = document.createElement('strong'),
          text = document.createElement('p');
        heading.textContent = item.actions.length ? 'Your decision is needed' : 'Approval resolved';
        text.textContent = item.fallback.text ?? '';
        card.append(heading, text);
        for (const action of item.actions) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = action.id.endsWith('/approve') ? 'Approve note write' : 'Reject';
          button.addEventListener('click', () => invoke(action.id, item.source));
          card.append(button);
        }
        return card;
      },
    },
    {
      id: 'playground/report',
      type: 'playground/report',
      schemaVersions: [1],
      target: 'chat',
      render(item) {
        const card = document.createElement('section');
        card.className = 'report-card';
        const tag = document.createElement('span'),
          title = document.createElement('h3'),
          text = document.createElement('p'),
          open = document.createElement('button'),
          download = document.createElement('a');
        tag.className = 'eyebrow';
        tag.textContent = 'FINALIZED ARTIFACT';
        title.textContent = item.fallback.label;
        text.textContent = item.fallback.text ?? '';
        open.type = 'button';
        open.textContent = 'Open report';
        open.addEventListener('click', () => inspect(item.id));
        download.textContent = 'Download ↓';
        download.href = `/api/artifacts/${encodeURIComponent(item.artifacts[0]!.id)}`;
        download.download = 'runtime-report.md';
        card.append(tag, title, text, open, download);
        return card;
      },
    },
  ];
}
export function command(actionId: string, target?: Contracts.EntityRef): Contracts.CommandRequest {
  return {
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    actionId,
    actionVersion: 1,
    input: null,
    ...(target ? { target } : {}),
  };
}
export function deliveryError(result: Client.CommandDelivery): string | undefined {
  return result.kind === 'receipt'
    ? ['rejected', 'failed'].includes(result.receipt.kind) && 'error' in result.receipt
      ? result.receipt.error.message
      : undefined
    : result.error.message;
}
