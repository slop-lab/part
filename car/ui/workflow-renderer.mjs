// @ts-check
import { isJson, isJsonObject } from '@slop-lab/part/contracts/index.js';

/** @param {Document} document */
export function createWorkflowRenderer(document) {
  /** @type {Map<string, {text: string, request?: import('@slop-lab/part/reference/index.js').Contracts.CommandRequest}>} */
  const drafts = new Map();
  return {
    id: 'car/workflow',
    target: /** @type {const} */ ('chat'),
    type: 'part/workflow',
    schemaVersions: [1],
    /** @param {import('@slop-lab/part/reference/index.js').Projection.Item} item
     * @param {import('@slop-lab/part/reference/index.js').UI.RenderContext} context */
    render(item, context) {
      const card = document.createElement('div');
      card.dataset.partPart = 'workflow';
      const title = document.createElement('strong');
      title.textContent = item.fallback.label;
      const summary = document.createElement('pre');
      summary.textContent = item.fallback.text ?? '';
      const status = document.createElement('p');
      status.setAttribute('aria-live', 'polite');
      card.append(title, summary, status);
      const payload = isJsonObject(item.payload) ? item.payload : undefined;
      if (payload) {
        const phase = document.createElement('p');
        phase.textContent = `State: ${String(payload.phase)} · effect: ${String(payload.effect)}`;
        card.append(phase);
      }
      for (const action of item.actions) {
        if (action.availability.state !== 'available') continue;
        const waits =
          action.id === 'part.workflow/respond' && Array.isArray(payload?.waits)
            ? payload.waits
            : [undefined];
        for (const wait of waits) {
          const ticket =
            isJsonObject(wait) &&
            isJsonObject(wait.ticket) &&
            typeof wait.ticket.id === 'string' &&
            typeof wait.ticket.revision === 'string'
              ? wait.ticket
              : undefined;
          if (action.id === 'part.workflow/respond' && !ticket) continue;
          const prompt = document.createElement('p');
          prompt.textContent =
            isJsonObject(wait) &&
            isJsonObject(wait.presentation) &&
            typeof wait.presentation.prompt === 'string'
              ? wait.presentation.prompt
              : action.id;
          const key = `${item.id}/${action.id}/${ticket?.id ?? 'action'}/${ticket?.revision ?? action.version}`;
          const draft = drafts.get(key) ?? {
            text: JSON.stringify(
              ticket ? { ticketId: ticket.id, revision: ticket.revision, response: null } : null,
              null,
              2,
            ),
          };
          drafts.set(key, draft);
          if (action.input.id === 'part/null') {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.id;
            button.addEventListener('click', () => {
              button.disabled = true;
              const commandId = crypto.randomUUID();
              void context.controller
                .invoke({
                  protocolVersion: 1,
                  commandId,
                  actionId: action.id,
                  actionVersion: action.version,
                  ...(item.source ? { target: item.source } : {}),
                  input: null,
                })
                .then((delivery) => {
                  status.textContent =
                    delivery.kind === 'receipt' ? delivery.receipt.kind : delivery.kind;
                })
                .finally(() => {
                  button.disabled = false;
                });
            });
            card.append(prompt, button);
            continue;
          }
          const form = document.createElement('form');
          const textarea = document.createElement('textarea');
          textarea.setAttribute('aria-label', `JSON input for ${action.id}`);
          textarea.value = draft.text;
          const submit = document.createElement('button');
          submit.type = 'submit';
          submit.textContent = 'Submit';
          textarea.addEventListener('input', () => {
            draft.text = textarea.value;
            draft.request = undefined;
          });
          form.append(textarea, submit);
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            /** @type {import('@slop-lab/part/reference/index.js').Contracts.Json} */
            let input;
            try {
              input = JSON.parse(textarea.value);
              if (!isJson(input)) throw new Error();
            } catch {
              status.textContent = 'Enter a valid JSON value.';
              return;
            }
            const commandId = crypto.randomUUID();
            draft.request ??= {
              protocolVersion: 1,
              commandId,
              actionId: action.id,
              actionVersion: action.version,
              ...(item.source ? { target: item.source } : {}),
              input,
            };
            submit.disabled = true;
            void context.controller
              .invoke(draft.request)
              .then((delivery) => {
                status.textContent =
                  delivery.kind === 'receipt'
                    ? delivery.receipt.kind
                    : delivery.kind === 'unknown'
                      ? 'Delivery unknown. The request was not repeated.'
                      : `Not sent: ${delivery.error.message}`;
                if (
                  delivery.kind === 'receipt' &&
                  ['accepted', 'completed'].includes(delivery.receipt.kind)
                )
                  draft.request = undefined;
              })
              .finally(() => {
                submit.disabled = false;
              });
          });
          card.append(prompt, form);
        }
      }
      return card;
    },
  };
}
