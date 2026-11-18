// @ts-check
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createChatGPTModel } from '@slop-lab/part-plugins/providers/index.js';
import { createBrowserSignIn, inferenceError } from './browser.mjs';
import { page } from './plan-web-page.mjs';
import { cookieValue } from './session-cookie.mjs';

/** @typedef {ReturnType<ReturnType<typeof createBrowserSignIn>['forUser']>} Connection */
/** @typedef {{connection: Connection, message?: string, reply?: string}} BrowserSession */

const port = Number(process.env.PART_SIWC_PORT ?? 4174);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PART_SIWC_PORT');
const signIn = createBrowserSignIn({ appName: 'part SIWC web example', scope: 'plan-web' });

/** @param {() => Promise<string>} accessToken @param {string} model @param {string} prompt */
async function ask(accessToken, model, prompt) {
  const agent = createAgent({
    model: createChatGPTModel({ model, accessToken, timeoutMs: 90_000 }),
  });
  if (!agent.ok) throw new Error(agent.error.message);
  try {
    const result = await agent.value.generate(prompt);
    if (!result.ok) return { message: inferenceError(result.error) };
    if (result.value.phase !== 'completed')
      return {
        message: result.value.error
          ? inferenceError(result.value.error)
          : `Run ${result.value.phase}.`,
      };
    return {
      reply: result.value.result.content
        .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
        .join('\n'),
    };
  } finally {
    await agent.value.dispose();
  }
}

/** @type {Map<string, BrowserSession>} */
const sessions = new Map();
let origin = '';
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  if (request.headers.host !== new URL(origin).host) {
    response.writeHead(404).end();
    return;
  }
  const cookie = 'part_siwc_web';
  const token = cookieValue(request.headers.cookie, cookie);
  let view = token ? sessions.get(token) : undefined;
  if (request.method === 'GET' && request.url === '/') {
    try {
      if (!view) {
        const restored = await signIn.cookies.restore(token);
        const id = restored ?? randomUUID();
        const signed = restored && token ? token : await signIn.cookies.issue(id);
        view = sessions.get(signed);
        if (!view) {
          if (sessions.size >= 16) {
            response.writeHead(503).end('Session capacity reached.');
            return;
          }
          view = { connection: signIn.forUser(id) };
          sessions.set(signed, view);
        }
        response.setHeader(
          'Set-Cookie',
          `${cookie}=${signed}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
        );
      }
      const account = await view.connection.state();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page({
          authorizationURL: account.authorizationURL ?? undefined,
          pending: account.pending,
          account: account.account ?? undefined,
          plan: account.plan,
          models: account.models,
          message: view.message ?? (account.message || undefined),
          reply: view.reply,
        }),
      );
    } catch {
      response.writeHead(500).end('Could not open local ChatGPT state.');
    }
    return;
  }
  if (request.method !== 'POST' || !view || request.headers.origin !== origin) {
    response.writeHead(403).end();
    return;
  }
  if (!['/signin', '/callback', '/models', '/ask'].includes(request.url ?? '')) {
    response.writeHead(404).end();
    return;
  }
  const length = Number(request.headers['content-length']);
  if (!Number.isInteger(length) || length < 0 || length > 16_384) {
    response.writeHead(413).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    view.message = undefined;
    if (request.url === '/signin') await view.connection.begin();
    else if (request.url === '/callback')
      await view.connection.complete(form.get('callbackURL') ?? '');
    else if (request.url === '/models') await view.connection.loadModels();
    else if (request.url === '/ask') {
      const account = await view.connection.state();
      const model = form.get('model');
      const prompt = form.get('prompt')?.trim();
      view.reply = undefined;
      if (account.plan && model && prompt && account.models.some(({ id }) => id === model)) {
        Object.assign(
          view,
          await ask(() => view.connection.accessToken(account.revision), model, prompt),
        );
      } else view.message = 'Choose an available model and enter a prompt.';
    }
  } catch {
    view.message = 'The local example could not process this request.';
  }
  response.writeHead(303, { Location: '/' }).end();
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing web server address');
origin = `http://127.0.0.1:${address.port}`;
console.log(origin);
