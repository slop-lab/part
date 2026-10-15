import { jsonCodec } from '@part/core/client';
import { commandSchema, querySchema } from '@part/core/client/control';
import { fail, isJsonObject, ok } from '@part/core/contracts';
import type { Client, Contracts } from '@part/core/reference';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
export async function startHttpHost(
  endpoint: Client.Endpoint,
  options: {
    context(
      request: IncomingMessage,
    ):
      | Promise<Contracts.Result<Contracts.InvocationContext>>
      | Contracts.Result<Contracts.InvocationContext>;
    host?: string;
    port?: number;
    maxBodyBytes?: number;
  },
): Promise<Contracts.Result<{ url: string; close(): Promise<void> }>> {
  const watchers = new Set<Client.WatchSession>();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    response.on('close', () => controller.abort());
    const json = (status: number, data: unknown) => {
      const encoded = jsonCodec.encode(data as Contracts.Json);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(encoded.ok ? encoded.value : '{"ok":false}');
    };
    try {
      const authenticated = await options.context(request);
      if (!authenticated.ok) {
        json(403, authenticated);
        return;
      }
      const context = {
        ...authenticated.value,
        signal: AbortSignal.any([authenticated.value.signal, controller.signal]),
      };
      if (request.method !== 'POST') {
        json(405, fail('http.method', 'POST required'));
        return;
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > (options.maxBodyBytes ?? 1024 * 1024)) {
          json(413, fail('http.body', 'Body too large'));
          return;
        }
        chunks.push(chunk);
      }
      const decoded = jsonCodec.decode(Buffer.concat(chunks));
      if (!decoded.ok) {
        json(400, decoded);
        return;
      }
      if (request.url === '/commands') {
        if (!commandSchema.validate(decoded.value).ok) {
          json(400, fail('command.envelope', 'Invalid command'));
          return;
        }
        json(
          200,
          await endpoint.command(decoded.value as unknown as Contracts.CommandRequest, context),
        );
        return;
      }
      if (request.url === '/queries') {
        if (!querySchema.validate(decoded.value).ok) {
          json(400, fail('query.envelope', 'Invalid query'));
          return;
        }
        json(
          200,
          await endpoint.query(decoded.value as unknown as Contracts.QueryRequest, context),
        );
        return;
      }
      if (request.url === '/events') {
        if (!isJsonObject(decoded.value) || typeof decoded.value.surface !== 'string') {
          json(400, fail('watch.envelope', 'Invalid watch request'));
          return;
        }
        const watched = await endpoint.watch(
          decoded.value as unknown as Client.WatchRequest,
          context,
        );
        if (!watched.ok) {
          json(403, watched);
          return;
        }
        watchers.add(watched.value);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const write = async (frame: unknown) => {
          if (!response.write(`data: ${JSON.stringify(frame)}\n\n`))
            await new Promise<void>((resolve) => {
              const done = () => {
                response.off('drain', done);
                response.off('close', done);
                resolve();
              };
              response.once('drain', done);
              response.once('close', done);
            });
        };
        try {
          await write({ kind: 'bootstrap', snapshot: watched.value.bootstrap });
          for await (const frame of watched.value.frames) {
            if (controller.signal.aborted) break;
            await write(frame);
          }
        } finally {
          watchers.delete(watched.value);
          await watched.value.close();
          response.end();
        }
        return;
      }
      json(404, fail('http.route', 'Unknown route', 'unsupported'));
    } catch {
      if (!response.headersSent)
        json(500, fail('http.failure', 'Endpoint request failed', 'internal'));
      else response.end();
    }
  });
  try {
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
    await once(server, 'listening');
  } catch {
    return fail('http.listen', 'Could not listen on HTTP endpoint', 'unavailable');
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    return fail('http.address', 'Invalid listen address');
  }
  return ok({
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}/`,
    async close() {
      for (const watch of watchers) await watch.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  });
}
