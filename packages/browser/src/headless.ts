/** @public */
import type { Client, Contracts, UI } from '@slop-lab/part/reference';
export function createComposer(options: {
  invoke: (request: Contracts.CommandRequest) => Promise<Client.CommandDelivery>;
  command: (draft: UI.Draft) => Contracts.CommandRequest;
}): UI.ComposerController {
  let draft: UI.Draft = { text: '', references: [], revision: 0 },
    composing = false,
    pending = false;
  return {
    getDraft: () => structuredClone(draft),
    setDraft(next) {
      draft = { ...structuredClone(next), revision: Math.max(draft.revision + 1, next.revision) };
    },
    setComposing(active) {
      composing = active;
    },
    canSubmit() {
      return composing
        ? { allowed: false, reason: 'Text composition is active' }
        : pending
          ? { allowed: false, reason: 'Submission in progress' }
          : !draft.text.trim()
            ? { allowed: false, reason: 'Draft is empty' }
            : { allowed: true };
    },
    async submit(_origin) {
      const captured = structuredClone(draft),
        permitted = this.canSubmit();
      if (!permitted.allowed)
        return {
          kind: 'not-sent',
          commandId: 'not-created',
          error: {
            code: 'part.composer.blocked',
            category: 'conflict',
            message: permitted.reason ?? 'Cannot submit',
            retry: 'never',
          },
        };
      pending = true;
      try {
        const delivery = await options.invoke(options.command(captured));
        if (
          delivery.kind === 'receipt' &&
          ['accepted', 'completed'].includes(delivery.receipt.kind) &&
          draft.revision === captured.revision
        )
          draft = { text: '', references: [], revision: draft.revision + 1 };
        return delivery;
      } finally {
        pending = false;
      }
    },
  };
}
export function createScroll(): UI.ScrollController & { contentChanged(): void } {
  let state: UI.ScrollState = { following: true, hasNewContent: false };
  return {
    getState: () => ({ ...state }),
    onUserScroll(distance) {
      state = {
        ...state,
        following: distance <= 48,
        ...(distance <= 48 ? { hasNewContent: false } : {}),
      };
    },
    followLatest() {
      state = { ...state, following: true, hasNewContent: false };
    },
    preserveAnchor(itemId) {
      state = { ...state, anchoredItemId: itemId, following: false };
    },
    contentChanged() {
      if (!state.following) state = { ...state, hasNewContent: true };
    },
  };
}
