// @ts-check
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isJsonObject } from '@slop-lab/part/contracts/index.js';
import {
  ChatGPTSignInError,
  createChatGPTAccounts,
  createSqliteChatGPTAccountStore,
  hasChatGPTPlanAccess,
  signInWithChatGPTLoopback,
} from '@slop-lab/part-node/siwc/index.js';
import { createExampleSessionCookies, readOrCreatePrivateValue } from './session-cookie.mjs';

/** @typedef {readonly {id: string, name: string}[]} Models */
/** @typedef {{url?: string, submit?: (url: string) => boolean, ready: Promise<void>, done: Promise<void>, controller: AbortController}} Attempt */

/** @param {string} operation @param {unknown} error */
export function siwcError(operation, error) {
  if (error instanceof ChatGPTSignInError)
    return `${operation}: ${[error.status && `HTTP ${error.status}`, error.code, error.requestId && `request ${error.requestId}`].filter(Boolean).join(' · ')}.`;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return `${operation}: the request timed out or was cancelled.`;
  return `${operation}: check that the selected account and endpoint are available.`;
}

/** @param {import('@slop-lab/part/reference/index.js').Contracts.Failure} failure */
export function inferenceError(failure) {
  const details = isJsonObject(failure.details) ? failure.details : {};
  const safe = (/** @type {unknown} */ entry) =>
    typeof entry === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(entry) ? entry : undefined;
  const status =
    typeof details.status === 'number'
      ? details.status
      : /^Provider returned HTTP (\d{3})$/.exec(failure.message)?.[1];
  const metadata = [
    status && `HTTP ${status}`,
    safe(details.code) ?? failure.code,
    safe(details.eventType) && `event ${safe(details.eventType)}`,
    safe(details.requestId) && `request ${safe(details.requestId)}`,
  ].filter(Boolean);
  const recovery =
    failure.code === 'part.auth.unavailable'
      ? ' Reconnect the selected account or check the server credential.'
      : '';
  return `Model request failed: ${metadata.join(' · ')}.${recovery}`;
}

/** @param {{environment?: NodeJS.ProcessEnv, appName: string, scope: 'playground' | 'plan-web', fetch?: typeof fetch}} options */
export function createBrowserSignIn({ environment = process.env, appName, scope, fetch: request }) {
  const directory = join(
    environment.PART_SIWC_DIRECTORY ?? join(homedir(), '.config', 'part-siwc-web'),
    scope,
  );
  const accounts = createChatGPTAccounts({
    store: createSqliteChatGPTAccountStore(join(directory, 'accounts')),
    fetch: request,
  });
  /** @type {Set<Attempt>} */
  const pending = new Set();
  /** @type {Promise<string> | undefined} */
  let host;
  let closed = false;
  return {
    cookies: createExampleSessionCookies(directory),
    /** @param {string} userId */
    forUser(userId) {
      const owner = accounts.forUser(userId);
      /** @type {Attempt | undefined} */
      let attempt;
      /** @type {Models} */
      let models = [];
      let revision = '';
      let message = '';
      return {
        /** @param {string} expected */
        async accessToken(expected) {
          if (attempt || !expected || expected !== revision)
            throw new Error('ChatGPT connection changed');
          const token = await owner.accessToken();
          if (attempt || expected !== revision) throw new Error('ChatGPT connection changed');
          return token;
        },
        async state() {
          const account = await owner.registration();
          if (account && !revision && !attempt) revision = randomUUID();
          return {
            enabled: true,
            pending: !!attempt,
            authorizationURL: attempt?.url ?? null,
            account: account
              ? (account.identity.name ?? account.identity.email ?? account.identity.subject)
              : null,
            plan: !!account && hasChatGPTPlanAccess(account),
            models,
            revision,
            message,
          };
        },
        async begin() {
          if (closed) return;
          if (attempt) return attempt.ready;
          const controller = new AbortController();
          /** @type {PromiseWithResolvers<void>} */
          const ready = Promise.withResolvers();
          /** @type {Attempt} */
          const current = {
            controller,
            ready: ready.promise,
            done: Promise.resolve(),
          };
          attempt = current;
          message = '';
          current.done = (async () => {
            try {
              const account = await owner.registration();
              host ??= Promise.resolve(
                environment.PART_SIWC_HOST_ID?.trim() ||
                  readOrCreatePrivateValue(directory, 'host-id', () => `urn:uuid:${randomUUID()}`),
              ).catch((error) => {
                host = undefined;
                throw error;
              });
              const result = await signInWithChatGPTLoopback({
                appName,
                hostId: await host,
                fetch: request,
                signal: controller.signal,
                registration: account && { identity: account.identity, hostId: account.hostId },
                requestConsent: !!account && !hasChatGPTPlanAccess(account),
                open(url, submit) {
                  current.url = url.href;
                  current.submit = submit;
                  ready.resolve();
                },
              });
              if (attempt !== current || closed) return;
              await owner.connect(result);
              if (attempt !== current || closed) return;
              models = [];
              revision = randomUUID();
              message = hasChatGPTPlanAccess(result)
                ? 'ChatGPT plan connected.'
                : 'Signed in. ChatGPT plan access was not granted.';
            } catch (error) {
              if (attempt === current) message = siwcError('ChatGPT sign-in failed', error);
            } finally {
              if (attempt === current) attempt = undefined;
              ready.resolve();
              pending.delete(current);
            }
          })();
          pending.add(current);
          return current.ready;
        },
        /** @param {string} callbackURL */
        async complete(callbackURL) {
          const current = attempt;
          if (!current?.submit?.(callbackURL)) {
            if (current) message = 'Paste the full callback URL from this sign-in attempt.';
            return;
          }
          await current.done;
        },
        async loadModels() {
          const activeRevision = revision;
          if (!activeRevision) return;
          try {
            const loaded = await owner.listModels();
            if (revision !== activeRevision) return;
            models = loaded;
            message = loaded.length ? '' : 'This account returned no displayable models.';
          } catch (error) {
            if (revision === activeRevision)
              message = siwcError('ChatGPT model list failed', error);
          }
        },
        async disconnect() {
          const current = attempt;
          attempt = undefined;
          current?.controller.abort();
          revision = '';
          models = [];
          message = 'ChatGPT disconnected from this browser session.';
          await owner.disconnect();
        },
      };
    },
    async close() {
      closed = true;
      for (const attempt of pending) attempt.controller.abort();
      await Promise.all([...pending].map((attempt) => attempt.done));
    },
  };
}
