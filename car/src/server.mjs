// @ts-check
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ok } from '@slop-lab/part/contracts/index.js';
import { startHttpHost } from '@slop-lab/part-node/host/http.js';

/** @param {Awaited<ReturnType<import('./runtime.mjs').openCar>>} car
 * @param {{token: string, context: import('@slop-lab/part/reference/index.js').Contracts.InvocationContext,
 * port?: number, host?: string, uiDirectory?: string}} options */
export async function startCarServer(car, options) {
  if (options.token.length < 16)
    throw new TypeError('CAR token must contain at least 16 characters');
  const expected = Buffer.from(`Bearer ${options.token}`);
  const backend = await startHttpHost(car.endpoint, {
    context(request) {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        ? ok(options.context)
        : fail('car.auth', 'CAR bearer token is required', 'permission');
    },
  });
  if (!backend.ok) throw new Error(backend.error.message);
  const ui = options.uiDirectory ?? fileURLToPath(new URL('../dist/ui/', import.meta.url));
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ]);
  const server = createServer((request, response) => {
    if (
      request.method === 'POST' &&
      ['/commands', '/queries', '/events'].includes(request.url ?? '')
    ) {
      const upstream = httpRequest(
        new URL(request.url ?? '/', backend.value.url),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
          },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, {
            ...incoming.headers,
            'cache-control': 'no-store',
          });
          incoming.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.once('close', () => upstream.destroy());
      request.pipe(upstream);
      return;
    }
    const asset = staticFiles.get(request.url ?? '');
    if (request.method !== 'GET' || !asset) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    void readFile(join(ui, asset[0] ?? ''))
      .then((bytes) => {
        response.writeHead(200, {
          'content-type': asset[1] ?? 'application/octet-stream',
          'content-security-policy':
            "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        response.end(bytes);
      })
      .catch(() => {
        response.writeHead(503);
        response.end('Build the CAR UI with npm run car:build');
      });
  });
  try {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    await backend.value.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CAR listen address unavailable');
  let closed = false;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}/`,
    async close() {
      if (closed) return;
      closed = true;
      await backend.value.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
