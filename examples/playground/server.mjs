import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { localContext, fail, ok } from '@part/core/contracts';
import { startHttpHost } from '@part/node/host/http';
import { createPlaygroundSession } from './runtime.mjs';
import { providerOptions } from './models.mjs';

export async function startPlayground({ port = 4173, environment = {}, delayScale = 1 } = {}) {
  const sessions = new Map(),
    hostToken = randomUUID();
  const assets = new Map(
    await Promise.all(
      [
        ['/', 'index.html', 'text/html; charset=utf-8'],
        ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
        ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
      ].map(async ([path, file, type]) => [
        path,
        { bytes: await readFile(new URL(`../../preview/${file}`, import.meta.url)), type },
      ]),
    ),
  );
  const findSession = (request) => {
    const id = /(?:^|;\s*)part_playground=([0-9a-f-]{36})(?:;|$)/.exec(
      request.headers.cookie ?? '',
    )?.[1];
    return id ? sessions.get(id) : undefined;
  };
  const hosted = await startHttpHost(
    {
      command: (request, context) =>
        sessions.get(context.principal.subject).endpoint.command(request, context),
      query: (request, context) =>
        sessions.get(context.principal.subject).endpoint.query(request, context),
      watch: (request, context) =>
        sessions.get(context.principal.subject).endpoint.watch(request, context),
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
  if (!hosted.ok) throw Error('Could not start the SDK HTTP host');
  let origin;
  const server = createServer(async (incoming, response) => {
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
      const path = new URL(incoming.url, origin).pathname;
      response.setHeader('x-content-type-options', 'nosniff');
      response.setHeader('referrer-policy', 'same-origin');
      response.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      if (incoming.method === 'GET' && path === '/api/bootstrap') {
        let session = findSession(incoming);
        if (!session) {
          if (sessions.size >= 16)
            return json(503, { error: 'Session capacity reached. Restart the playground server.' });
          const id = randomUUID();
          session = createPlaygroundSession({
            environment,
            delayScale,
            context: localContext({ principal: { subject: id, authority: 'part/playground' } }),
          });
          sessions.set(id, session);
          response.setHeader(
            'set-cookie',
            `part_playground=${id}; HttpOnly; SameSite=Strict; Path=/`,
          );
        }
        return json(200, {
          providers: providerOptions(environment),
          model: environment.R4U_MODEL || 'gpt-6-luna',
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
      if (incoming.method === 'GET' && /^\/api\/artifacts\/[0-9a-f-]{36}$/.test(path)) {
        const artifact = await session.artifact(path.split('/').at(-1));
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
          response.writeHead(remote.statusCode, {
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
  origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return {
    url: origin,
    close() {
      return (closing ??= (async () => {
        await Promise.all([...sessions.values()].map((session) => session.close()));
        await hosted.value.close();
        const stopped = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await stopped;
      })());
    },
  };
}
