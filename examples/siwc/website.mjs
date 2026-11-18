// @ts-check
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createChatGPTSignIn } from '@slop-lab/part-node/siwc/index.js';

const {
  PART_SIWC_CLIENT_ID,
  PART_SIWC_CLIENT_SECRET,
  PART_SIWC_CALLBACK_URL,
  PART_SIWC_TLS_CERT,
  PART_SIWC_TLS_KEY,
} = process.env;
if (!PART_SIWC_CLIENT_ID || !PART_SIWC_CALLBACK_URL || !PART_SIWC_TLS_CERT || !PART_SIWC_TLS_KEY)
  throw new Error(
    'Set PART_SIWC_CLIENT_ID, PART_SIWC_CALLBACK_URL, PART_SIWC_TLS_CERT and PART_SIWC_TLS_KEY',
  );

const callbackURL = new URL(PART_SIWC_CALLBACK_URL);
if (callbackURL.protocol !== 'https:' || callbackURL.pathname !== '/auth/chatgpt/callback')
  throw new Error('Use the registered HTTPS callback with path /auth/chatgpt/callback');
const signIn = createChatGPTSignIn({
  clientId: PART_SIWC_CLIENT_ID,
  clientSecret: PART_SIWC_CLIENT_SECRET,
  redirectURI: callbackURL,
});
/** @type {Map<string, ReturnType<typeof signIn.begin>['transaction']>} */
const attempts = new Map();
/** @type {Map<string, { identity: Awaited<ReturnType<typeof signIn.complete>>, expiresAt: number }>} */
const sessions = new Map();
const attemptCookie = '__Host-chatgpt-signin';
const sessionCookie = '__Host-part-session';

/** @param {string} name @param {string} value @param {number} maxAge */
function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
/** @param {string | undefined} header @param {string} name */
function readCookie(header, name) {
  return (
    header
      ?.split(';')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}

const server = createServer(
  { key: readFileSync(PART_SIWC_TLS_KEY), cert: readFileSync(PART_SIWC_TLS_CERT) },
  async (request, response) => {
    const target = request.url ?? '';
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (
      request.method !== 'GET' ||
      request.headers.host !== callbackURL.host ||
      !/^\/(?!\/)/.test(target)
    ) {
      response.writeHead(404).end();
      return;
    }
    const url = new URL(target, callbackURL.origin);
    for (const [id, attempt] of attempts) if (attempt.expiresAt <= Date.now()) attempts.delete(id);
    for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);

    if (url.pathname === '/auth/chatgpt') {
      const { url: authorizationURL, transaction } = signIn.begin();
      attempts.delete(readCookie(request.headers.cookie, attemptCookie));
      const attemptId = randomUUID();
      attempts.set(attemptId, transaction);
      response
        .writeHead(302, {
          Location: authorizationURL.href,
          'Set-Cookie': cookie(attemptCookie, attemptId, 600),
        })
        .end();
    } else if (url.pathname === callbackURL.pathname) {
      const attemptId = readCookie(request.headers.cookie, attemptCookie);
      const transaction = attempts.get(attemptId);
      attempts.delete(attemptId);
      const clear = cookie(attemptCookie, '', 0);
      try {
        if (!transaction) throw new Error('Missing sign-in attempt');
        const identity = await signIn.complete(url, transaction);
        // Look up an application account by issuer, clientId and subject in a real application.
        sessions.delete(readCookie(request.headers.cookie, sessionCookie));
        const sessionId = randomUUID();
        sessions.set(sessionId, { identity, expiresAt: Date.now() + 3600_000 });
        response
          .writeHead(302, {
            Location: '/',
            'Set-Cookie': [clear, cookie(sessionCookie, sessionId, 3600)],
          })
          .end();
      } catch {
        response
          .writeHead(400, { 'Set-Cookie': clear, 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Sign-in could not be completed. Start a new sign-in.');
      }
    } else if (url.pathname === '/') {
      const session = sessions.get(readCookie(request.headers.cookie, sessionCookie));
      if (session) {
        response
          .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`Signed in as ${session.identity.name ?? session.identity.subject}.`);
      } else {
        response
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(
            '<!doctype html><title>Sign in</title><a href="/auth/chatgpt" data-oai-siwc-button>Continue with ChatGPT</a>',
          );
      }
    } else response.writeHead(404).end();
  },
);
server.listen(Number(callbackURL.port || 443));
console.log(`Listening on ${callbackURL.origin}`);
