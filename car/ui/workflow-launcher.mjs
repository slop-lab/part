// @ts-check
import { isJson, isJsonObject } from '@slop-lab/part/contracts/index.js';

/** @typedef {import('@slop-lab/part/reference/index.js').Client.Controller} Controller */
/** @typedef {{engineId: string, definition: {id: string, digest: string},
 * profileIds: readonly string[], composition: {id: string, revision: string}}} Definition */

/** @param {import('@slop-lab/part/reference/index.js').Client.CommandDelivery} delivery */
function deliveryText(delivery) {
  if (delivery.kind === 'unknown') return 'Delivery unknown. The request was not repeated.';
  if (delivery.kind === 'not-sent') return `Not sent: ${delivery.error.message}`;
  const receipt = delivery.receipt;
  if (receipt.kind === 'accepted') return `Accepted · execution ${receipt.operation.id}`;
  if (receipt.kind === 'completed') return 'Completed';
  return `${receipt.kind === 'rejected' ? 'Rejected' : 'Failed'}: ${receipt.error.message}`;
}

/** @param {unknown} value @returns {Definition | undefined} */
function definition(value) {
  if (
    !isJsonObject(value) ||
    typeof value.engineId !== 'string' ||
    !isJsonObject(value.definition) ||
    typeof value.definition.id !== 'string' ||
    typeof value.definition.digest !== 'string' ||
    !Array.isArray(value.profileIds) ||
    !value.profileIds.every((profile) => typeof profile === 'string') ||
    !isJsonObject(value.composition) ||
    typeof value.composition.id !== 'string' ||
    typeof value.composition.revision !== 'string'
  )
    return undefined;
  return {
    engineId: value.engineId,
    definition: { id: value.definition.id, digest: value.definition.digest },
    profileIds: value.profileIds,
    composition: { id: value.composition.id, revision: value.composition.revision },
  };
}

/** @param {{document: Document, client: Controller}} options */
export function createWorkflowLauncher(options) {
  const { document, client } = options;
  const root = document.createElement('section');
  root.className = 'car-workflow-launcher';
  const form = document.createElement('form');
  form.dataset.carQuery = 'workflow-start';
  form.className = 'car-workflow-form';
  const definitionLabel = document.createElement('label');
  definitionLabel.textContent = 'Registered definition';
  const select = document.createElement('select');
  select.name = 'definition';
  definitionLabel.append(select);
  const inputLabel = document.createElement('label');
  inputLabel.textContent = 'JSON input';
  const input = document.createElement('textarea');
  input.name = 'input';
  input.rows = 6;
  input.value = '{}';
  inputLabel.append(input);
  const start = document.createElement('button');
  start.type = 'submit';
  start.textContent = 'Start workflow';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.dataset.carAction = 'workflow-cancel';
  cancel.textContent = 'Request cancellation';
  cancel.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'car-workflow-actions';
  actions.append(start, cancel);
  const status = document.createElement('p');
  status.setAttribute('aria-live', 'polite');
  status.dataset.state = 'idle';
  form.append(definitionLabel, inputLabel, actions);
  root.append(form, status);
  /** @type {Definition[]} */
  let definitions = [];
  /** @type {import('@slop-lab/part/reference/index.js').Contracts.EntityRef | undefined} */
  let execution;
  let disposed = false;
  let revision = 0;

  /** @param {string} text @param {'idle'|'loading'|'success'|'warning'|'error'} state */
  function setStatus(text, state) {
    status.textContent = text;
    status.dataset.state = state;
  }

  /** @param {import('@slop-lab/part/reference/index.js').Client.CommandDelivery} delivery */
  function deliveryState(delivery) {
    if (delivery.kind === 'unknown') return /** @type {const} */ ('warning');
    if (delivery.kind === 'not-sent') return /** @type {const} */ ('error');
    return delivery.receipt.kind === 'accepted' || delivery.receipt.kind === 'completed'
      ? /** @type {const} */ ('success')
      : /** @type {const} */ ('error');
  }

  async function refresh() {
    const current = ++revision;
    definitions = [];
    select.replaceChildren();
    select.disabled = true;
    start.disabled = true;
    setStatus('Loading workflow definitions…', 'loading');
    const result = await client.port.query({
      queryId: 'part.workflow/definitions',
      version: 1,
      input: null,
    });
    if (disposed || current !== revision) return;
    if (!result.ok) {
      select.disabled = false;
      setStatus(`Definitions unavailable: ${result.error.message}`, 'error');
      return;
    }
    definitions = [];
    if (Array.isArray(result.value)) {
      for (const value of result.value) {
        const entry = definition(value);
        if (entry?.profileIds.includes('default')) definitions.push(entry);
      }
    }
    select.replaceChildren(
      ...definitions.map((entry, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `${entry.definition.id} · ${entry.engineId}`;
        return option;
      }),
    );
    start.disabled = definitions.length === 0;
    select.disabled = false;
    setStatus(
      definitions.length
        ? `${definitions.length} registered definition${definitions.length === 1 ? '' : 's'}`
        : 'No workflow definition supports the default profile.',
      definitions.length ? 'success' : 'warning',
    );
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = definitions[Number(select.value)];
    if (!selected) {
      setStatus('Select a registered workflow definition.', 'warning');
      return;
    }
    /** @type {import('@slop-lab/part/reference/index.js').Contracts.Json} */
    let parsed;
    try {
      parsed = JSON.parse(input.value);
      if (!isJson(parsed)) throw new Error('Invalid JSON');
    } catch {
      setStatus('Enter valid JSON workflow input.', 'error');
      return;
    }
    const commandId = crypto.randomUUID();
    start.disabled = true;
    setStatus('Starting workflow…', 'loading');
    void client
      .invoke({
        protocolVersion: 1,
        commandId,
        idempotencyKey: commandId,
        actionId: 'part.workflow/start',
        actionVersion: 1,
        input: {
          engineId: selected.engineId,
          definition: selected.definition,
          profileId: 'default',
          composition: selected.composition,
          input: parsed,
          requiredControl: 'runner-enforced',
          requiredCapabilities: [],
        },
      })
      .then((delivery) => {
        if (disposed) return;
        setStatus(deliveryText(delivery), deliveryState(delivery));
        execution =
          delivery.kind === 'receipt' && delivery.receipt.kind === 'accepted'
            ? delivery.receipt.operation
            : undefined;
        cancel.hidden = !execution;
      })
      .finally(() => {
        if (!disposed) start.disabled = definitions.length === 0;
      });
  });

  cancel.addEventListener('click', () => {
    if (!execution) return;
    const commandId = crypto.randomUUID();
    cancel.disabled = true;
    setStatus('Requesting cancellation…', 'loading');
    void client
      .invoke({
        protocolVersion: 1,
        commandId,
        idempotencyKey: commandId,
        actionId: 'part.workflow/cancel',
        actionVersion: 1,
        target: execution,
        input: null,
      })
      .then((delivery) => {
        if (!disposed)
          setStatus(
            `Cancellation ${deliveryText(delivery).toLowerCase()}`,
            deliveryState(delivery),
          );
      })
      .finally(() => {
        if (!disposed) cancel.disabled = false;
      });
  });

  return {
    element: root,
    refresh,
    dispose() {
      disposed = true;
      revision++;
      root.remove();
    },
  };
}
