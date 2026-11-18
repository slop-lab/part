import { hasChatGPTPlanAccess } from './oauth.js';
import type { ChatGPTCredentials, ChatGPTRegistration } from './oauth.js';
import { createChatGPTSession } from './session.js';

/** Server-side storage keyed by your authenticated application user or account ID. */
export interface ChatGPTAccountStore {
  /**
   * Serialize operations for the same owner across store clients. `save` atomically
   * persists the entire record before it resolves, including rotated refresh tokens.
   */
  withAccount<T>(
    owner: string,
    run: (
      account: ChatGPTRegistration | undefined,
      save: (next: ChatGPTRegistration | undefined) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}

/** An isolated in-memory store for examples and single-process sessions. */
export function createMemoryChatGPTAccountStore(): ChatGPTAccountStore {
  const accounts = new Map<string, ChatGPTRegistration>();
  const pending = new Map<string, Promise<unknown>>();
  return {
    async withAccount(owner, run) {
      const task = (pending.get(owner) ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          run(structuredClone(accounts.get(owner)), async (next) => {
            if (next) accounts.set(owner, structuredClone(next));
            else accounts.delete(owner);
          }),
        );
      pending.set(owner, task);
      try {
        return await task;
      } finally {
        if (pending.get(owner) === task) pending.delete(owner);
      }
    },
  };
}

/** Bind shared SDK configuration to separate authenticated app users. */
export function createChatGPTAccounts(options: {
  store: ChatGPTAccountStore;
  fetch?: typeof fetch;
}) {
  const unwritten = new Map<string, { previous: ChatGPTCredentials; next: ChatGPTCredentials }>();
  return {
    forUser(owner: string) {
      if (!owner.trim()) throw new Error('An application user ID is required');
      const store = options.store;
      function replace(account: ChatGPTRegistration | undefined) {
        return store.withAccount(owner, async (_, save) => {
          await save(account);
          unwritten.delete(owner);
        });
      }
      function withSession<T>(
        run: (session: ReturnType<typeof createChatGPTSession>) => Promise<T>,
      ) {
        return store.withAccount(owner, async (account, save) => {
          if (!account || !hasChatGPTPlanAccess(account))
            throw new Error('ChatGPT plan usage has not been authorized for this user');
          let credentials: ChatGPTCredentials = account;
          const pending = unwritten.get(owner);
          if (pending) {
            // If a refresh succeeded before a storage error, reuse its replacement on retry.
            if (
              account.identity.clientId === pending.previous.identity.clientId &&
              account.identity.subject === pending.previous.identity.subject &&
              account.accessToken === pending.previous.accessToken &&
              account.refreshToken === pending.previous.refreshToken
            ) {
              await save(pending.next);
              credentials = pending.next;
            }
            unwritten.delete(owner);
          }
          const previous = credentials;
          return run(
            createChatGPTSession({
              credentials,
              fetch: options.fetch,
              async save(next) {
                unwritten.set(owner, { previous, next });
                await save(next);
                unwritten.delete(owner);
              },
            }),
          );
        });
      }
      return {
        /** Load a server-only registration, for example to begin a returning sign-in. */
        registration: () => store.withAccount(owner, async (account) => account),
        /** Save the verified result of an SIWC authorization. */
        connect: (account: ChatGPTRegistration) => replace(account),
        /** Unlink the grant locally. In-flight calls can finish with their bound credential. */
        disconnect: () => replace(undefined),
        accessToken: () => withSession((session) => session.accessToken()),
        listModels: () => withSession((session) => session.listModels()),
        codexAppServer: () => withSession((session) => session.codexAppServer()),
      };
    },
  };
}
