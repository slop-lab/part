import { once } from 'node:events';
import { createServer } from 'node:http';
import { createChatGPTPlanSignIn } from './oauth.js';
import type { ChatGPTPlanOptions, ChatGPTRegistration } from './oauth.js';

export interface ChatGPTLoopbackOptions extends Omit<ChatGPTPlanOptions, 'redirectURI'> {
  /** Submit a pasted callback when the browser cannot reach this process's loopback listener. */
  open: (url: URL, submitCallback: (callbackURL: string) => boolean) => void | Promise<void>;
  registration?: ChatGPTRegistration;
  requestConsent?: boolean;
  /** Keep the same path for a registration. Port zero selects an available port. */
  callbackPath?: string;
  port?: number;
  signal?: AbortSignal;
}

/** Bind the local callback before handing the authorization URL to the host. */
export async function signInWithChatGPTLoopback(options: ChatGPTLoopbackOptions) {
  const path = options.callbackPath ?? '/auth/callback';
  if (
    !/^\/(?:[\w.-]+\/)*[\w.-]+$/.test(path) ||
    new URL(path, 'http://127.0.0.1').pathname !== path
  )
    throw new Error('Invalid SIWC loopback callback path');
  options.signal?.throwIfAborted();
  const server = createServer();
  try {
    server.listen(options.port ?? 0, '127.0.0.1');
    await once(server, 'listening', { signal: options.signal });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('SIWC loopback listener unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const redirectURI = origin + path;
    const client = createChatGPTPlanSignIn({ ...options, redirectURI });
    const { url, transaction } = client.begin(options.registration, {
      requestConsent: options.requestConsent,
    });
    const timeout = AbortSignal.timeout(Math.max(1, transaction.expiresAt - Date.now()));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let resolveCallback: ((result: ChatGPTRegistration) => void) | undefined;
    let rejectCallback: ((reason: unknown) => void) | undefined;
    const callback = new Promise<ChatGPTRegistration>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const abort = () => rejectCallback?.(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let claimed = false;
    function claimCallback(callbackURL: URL): Promise<ChatGPTRegistration> | undefined {
      const endpoint = new URL(callbackURL);
      endpoint.search = '';
      const states = callbackURL.searchParams.getAll('state');
      if (
        claimed ||
        signal.aborted ||
        endpoint.href !== redirectURI ||
        states.length !== 1 ||
        states[0] !== transaction.state ||
        (!callbackURL.searchParams.get('code') && !callbackURL.searchParams.get('error'))
      )
        return;
      claimed = true;
      return client.complete(callbackURL, transaction).then((result) => {
        signal.throwIfAborted();
        return result;
      });
    }

    function submitCallback(pasted: string): boolean {
      const callbackURL = URL.parse(pasted.trim());
      if (!callbackURL) return false;
      const completion = claimCallback(callbackURL);
      if (!completion) return false;
      void completion.then(resolveCallback, rejectCallback);
      return true;
    }

    server.on('request', async (request, response) => {
      const target = request.url ?? '';
      const validRoute = target === path || target.startsWith(`${path}?`);
      if (
        request.method !== 'GET' ||
        request.headers.host !== `127.0.0.1:${address.port}` ||
        !validRoute
      ) {
        response.writeHead(404).end();
        return;
      }
      const completion = claimCallback(new URL(origin + target));
      if (!completion) {
        response.writeHead(400).end('Invalid or expired sign-in');
        return;
      }
      const headers = {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      };
      try {
        const result = await completion;
        response
          .writeHead(200, headers)
          .end('Sign-in complete. You can return to the application.');
        resolveCallback?.(result);
      } catch (error) {
        response
          .writeHead(400, headers)
          .end('Sign-in failed. Return to the application to try again.');
        rejectCallback?.(error);
      }
    });
    try {
      // A host may return once it opens a browser, or keep the open operation pending.
      if (signal.aborted) abort();
      else
        void Promise.resolve()
          .then(() => options.open(url, submitCallback))
          .catch(rejectCallback);
      return await callback;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
