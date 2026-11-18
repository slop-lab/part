// @ts-check
import { startHttpHost } from '@slop-lab/part-node/host/http.js';
import { fail, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createBrowserSignIn } from '../siwc/browser.mjs';
import { cookieValue } from '../siwc/session-cookie.mjs';
import { providerOptions } from './models.mjs';
import { createPlaygroundSession } from './runtime.mjs';

export async function startPlayground({
  port = 4173,
  environment = /** @type {NodeJS.ProcessEnv} */ ({}),
  delayScale = 1,
  fetch = /** @type {typeof globalThis.fetch | undefined} */ (undefined),
} = {}) {
  /** @type {Map<string, { token: string, session: ReturnType<typeof createPlaygroundSession> }>} */
  const sessions = new Map();
  const signIn =
    environment.PART_PLAYGROUND_SIWC === '0'
      ? undefined
      : createBrowserSignIn({
          environment,
          appName: 'part Playground',
          scope: 'playground',
          fetch,
        });
  const hostToken = randomUUID();
  /** @param {string} id */
  function sessionFor(id) {
    const session = sessions.get(id);
    if (!session) throw Error('Unknown session');
    return session.session;
  }
  const assets = new Map(
    await Promise.all(
      [
        ['/', 'index.html', 'text/html; charset=utf-8'],
        ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
        ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
      ].map(
        async ([path, file, type]) =>
          /** @type {const} */ ([
            path,
            { bytes: await readFile(new URL(`../../preview/${file}`, import.meta.url)), type },
          ]),
      ),
    ),
  );
  /** @param {import("node:http").IncomingMessage} request */
  const findSession = (request) => {
    const token = cookieValue(request.headers.cookie, 'part_playground');
    const id = token?.split('.')[0];
    const entry = id ? sessions.get(id) : undefined;
    return entry && entry.token === token ? entry.session : undefined;
  };
  const hosted = await startHttpHost(
    {
      command: (request, context) =>
        sessionFor(context.principal.subject).endpoint.command(request),
      query: (request, context) => sessionFor(context.principal.subject).endpoint.query(request),
      watch: (request, context) =>
        sessionFor(context.principal.subject).endpoint.watch(request, context),
    },
    {
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 64 * 1024,
      context(request) {
        const session = findSession(request);
        return request.headers['x-playground-host'] === hostToken && session
          ? ok(session.context)
          : fail('playground.auth', 'Unknown session', 'permission');
      },
    },
  );
  if (hosted.ok === false) throw Error('Could not start the SDK HTTP host');
  let origin = '';
  const server = createServer(async (incoming, response) => {
    /** @param {number} status @param {import("@slop-lab/part/reference/index.js").Contracts.Json} body */
    const json = (status, body) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (
        incoming.headers.host !== new URL(origin).host ||
        (incoming.headers.origin && incoming.headers.origin !== origin) ||
        incoming.headers['sec-fetch-site'] === 'cross-site'
      )
        return json(403, { error: 'Use the local playground origin.' });
      const path = new URL(incoming.url ?? '/', origin).pathname;
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'same-origin');
      response.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      if (incoming.method === 'GET' && path === '/api/bootstrap') {
        let session = findSession(incoming);
        if (!session) {
          const existing = cookieValue(incoming.headers.cookie, 'part_playground');
          const restored = await signIn?.cookies.restore(existing);
          const id = restored ?? randomUUID();
          const token = restored && existing ? existing : ((await signIn?.cookies.issue(id)) ?? id);
          session = sessions.get(id)?.session;
          if (!session) {
            if (sessions.size >= 16)
              return json(503, {
                error: 'Session capacity reached. Restart the playground server.',
              });
            session = createPlaygroundSession({
              environment,
              delayScale,
              fetch,
              siwc: signIn?.forUser(id),
              context: localContext({ principal: { subject: id, authority: 'part/playground' } }),
            });
            sessions.set(id, { session, token });
          }
          response.setHeader(
            'set-cookie',
            `part_playground=${token}; HttpOnly; SameSite=Strict; Path=/${signIn ? '; Max-Age=2592000' : ''}`,
          );
        }
        const siwc = await session.siwc?.state();
        const providers = providerOptions(environment, !!siwc, !!siwc?.plan);
        const preferred = environment.PART_PLAYGROUND_PROVIDER;
        return json(200, {
          providers,
          preferred: providers.some(({ id, available }) => id === preferred && available)
            ? (preferred ?? 'scripted')
            : 'scripted',
          model: environment.OPENAI_MODEL || 'gpt-4.1-mini',
          anthropicModel: environment.ANTHROPIC_MODEL || '',
          siwc: siwc ? { ...siwc, revision: null } : null,
        });
      }
      const asset = assets.get(path);
      if (incoming.method === 'GET' && asset) {
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        response.end(asset.bytes);
        return;
      }
      if (path === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      const session = findSession(incoming);
      if (!session) return json(403, { error: 'Open the playground before using its API.' });
      if (path.startsWith('/api/siwc/')) {
        const siwc = session.siwc;
        if (!siwc) return json(404, { error: 'ChatGPT connection is disabled.' });
        if (incoming.method === 'POST' && incoming.headers.origin === origin) {
          if (path === '/api/siwc/begin') await siwc.begin();
          else if (path === '/api/siwc/models') await siwc.loadModels();
          else if (path === '/api/siwc/disconnect') await siwc.disconnect();
          else if (path === '/api/siwc/callback') {
            const size = Number(incoming.headers['content-length']);
            if (!Number.isSafeInteger(size) || size < 1 || size > 8192)
              return json(400, { error: 'Paste the full callback URL.' });
            const chunks = [];
            for await (const chunk of incoming) chunks.push(chunk);
            await siwc.complete(Buffer.concat(chunks).toString('utf8'));
          } else return json(404, { error: 'Unknown ChatGPT action.' });
        } else if (incoming.method !== 'GET' || path !== '/api/siwc/state') {
          return json(403, { error: 'Use the local playground origin.' });
        }
        return json(200, { ...(await siwc.state()), revision: null });
      }
      if (incoming.method === 'GET' && /^\/api\/artifacts\/[0-9a-f-]{36}$/.test(path)) {
        const artifact = await session.artifact(path.slice('/api/artifacts/'.length));
        if (!artifact) return json(404, { error: 'Artifact not found in this session.' });
        response.writeHead(200, {
          'content-type': artifact.mediaType,
          'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="runtime-report.md"',
        });
        response.end(artifact.bytes);
        return;
      }
      if (
        incoming.method !== 'POST' ||
        !['/api/commands', '/api/queries', '/api/events'].includes(path)
      )
        return json(404, { error: 'Not found' });
      // Reuse the public SDK host and HTTP/SSE client on the same browser origin.
      const upstream = request(
        new URL(path.slice(4), hosted.value.url),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: incoming.headers.cookie,
            'x-playground-host': hostToken,
          },
        },
        (remote) => {
          response.writeHead(remote.statusCode ?? 502, {
            'content-type': remote.headers['content-type'],
            'cache-control': 'no-store',
          });
          remote.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) json(502, { error: 'Local runtime host unavailable' });
        else response.end();
      });
      response.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    } catch {
      if (!response.headersSent) json(500, { error: 'Playground request failed' });
      else response.end();
    }
  });
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    await hosted.value.close();
    throw error;
  }
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    url: origin,
    close() {
      return (closing ??= (async () => {
        await signIn?.close();
        await Promise.all([...sessions.values()].map(({ session }) => session.close()));
        await hosted.value.close();
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await stopped;
      })());
    },
  };
}
