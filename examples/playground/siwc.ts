export interface SiwcState {
  pending: boolean;
  authorizationURL: string | null;
  account: string | null;
  plan: boolean;
  models: { id: string; name: string }[];
  message: string;
}

export function connectChatGPT(
  initial: SiwcState,
  updateProvider: (state: SiwcState, modelId?: string) => void,
  currentModel: () => string | undefined,
) {
  const opener = document.querySelector<HTMLButtonElement>('#siwc-open')!;
  const dialog = document.querySelector<HTMLDialogElement>('#siwc-dialog')!;
  const account = dialog.querySelector<HTMLElement>('#siwc-account')!;
  const status = dialog.querySelector<HTMLElement>('#siwc-status')!;
  const begin = dialog.querySelector<HTMLButtonElement>('#siwc-begin')!;
  const pending = dialog.querySelector<HTMLElement>('#siwc-pending')!;
  const link = dialog.querySelector<HTMLAnchorElement>('#siwc-link')!;
  const callback = dialog.querySelector<HTMLFormElement>('#siwc-callback')!;
  const input = dialog.querySelector<HTMLInputElement>('#siwc-url')!;
  const models = dialog.querySelector<HTMLButtonElement>('#siwc-models')!;
  const picker = dialog.querySelector<HTMLElement>('#siwc-model-picker')!;
  const modelList = dialog.querySelector<HTMLSelectElement>('#siwc-model-list')!;
  const disconnect = dialog.querySelector<HTMLButtonElement>('#siwc-disconnect')!;
  let state = initial;
  let busy = false;
  let renderedModels: SiwcState['models'] | undefined;

  function render(select = false) {
    opener.textContent = state.account ? 'ChatGPT connected' : 'Connect ChatGPT';
    account.hidden = !state.account;
    account.textContent = state.account ? `Signed in as ${state.account}` : '';
    status.textContent = state.message;
    begin.hidden = state.pending || state.plan;
    begin.textContent = state.account ? 'Authorize ChatGPT plan' : 'Continue with ChatGPT';
    pending.hidden = !state.authorizationURL;
    if (state.authorizationURL) link.href = state.authorizationURL;
    else link.removeAttribute('href');
    models.hidden = !state.plan || state.pending;
    picker.hidden = models.hidden || !state.models.length;
    if (renderedModels !== state.models) {
      renderedModels = state.models;
      const previous = currentModel() ?? modelList.value;
      modelList.replaceChildren(...state.models.map(({ id, name }) => new Option(name, id)));
      modelList.size = Math.max(2, Math.min(state.models.length, 5));
      modelList.value = state.models.some(({ id }) => id === previous)
        ? previous
        : (state.models[0]?.id ?? '');
    }
    modelList.disabled = busy;
    disconnect.hidden = !state.account && !state.pending;
    disconnect.textContent = state.account ? 'Disconnect' : 'Cancel sign-in';
    for (const button of [begin, models, disconnect, callback.querySelector('button')!])
      button.disabled = busy;
    updateProvider(state, select && !picker.hidden ? modelList.value : undefined);
  }

  async function action(name: string, body?: string) {
    if (busy) return;
    busy = true;
    render();
    try {
      const response = await fetch(
        `/api/siwc/${name}`,
        name === 'state' ? {} : { method: 'POST', body },
      );
      const result = (await response.json()) as SiwcState & { error?: string };
      if (!response.ok) throw new Error(result.error || 'ChatGPT connection request failed.');
      state = result;
      if (name === 'callback' || !state.pending) input.value = '';
    } catch (error) {
      state = {
        ...state,
        message: error instanceof Error ? error.message : 'ChatGPT connection request failed.',
      };
    } finally {
      busy = false;
      render(name === 'models' && !state.message);
    }
  }

  opener.hidden = false;
  opener.addEventListener('click', () => {
    dialog.showModal();
    void action('state');
  });
  dialog.querySelector('#siwc-close')!.addEventListener('click', () => dialog.close());
  begin.addEventListener('click', () => void action('begin'));
  models.addEventListener('click', () => void action('models'));
  modelList.addEventListener('change', () => updateProvider(state, modelList.value));
  disconnect.addEventListener('click', () => void action('disconnect'));
  callback.addEventListener('submit', (event) => {
    event.preventDefault();
    void action('callback', input.value);
  });
  const timer = setInterval(() => {
    if (dialog.open && state.pending && !busy) void action('state');
  }, 1500);
  render();
  return () => clearInterval(timer);
}
