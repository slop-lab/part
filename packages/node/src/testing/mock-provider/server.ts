import { isJsonObject } from '@part/core/contracts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { createMockBroker } from './broker.js';
import { encodeReply, errorBody, readChatRequest, readFixture, readReply } from './protocol.js';
import type { MockFixture, MockProject, MockReply, MockSession } from './types.js';

async function readBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw Error('Request body exceeds byte limit');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function startMockProvider(options: {
  mode: 'interactive' | 'fixed';
  project: MockProject;
  fixture?: MockFixture;
  port?: number;
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  maxRequests?: number;
  maxPending?: number;
}) {
  options = {
    ...options,
    project: structuredClone(options.project),
    ...(options.fixture ? { fixture: readFixture(options.fixture) } : {}),
  };
  const timeout = options.requestTimeoutMs ?? 300000,
    maximum = options.maxBodyBytes ?? 1024 * 1024,
    outputMaximum = options.maxResponseBytes ?? 4 * 1024 * 1024;
  for (const value of [
    timeout,
    maximum,
    outputMaximum,
    options.maxRequests ?? 1000,
    options.maxPending ?? 128,
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
      throw Error('Limits must be positive bounded integers');
  if (!options.project.id || !['interactive', 'fixed'].includes(options.mode))
    throw Error('Project ID and valid mode are required');
  const broker = createMockBroker({
    ...options,
    maxRequests: options.maxRequests ?? 1000,
    maxPending: options.maxPending ?? 128,
  });
  const apiKey = randomUUID(),
    controlToken = randomUUID();
  const boundedReply = (
    request: Parameters<typeof encodeReply>[0],
    reply: MockReply,
    id: string,
  ) => {
    const encoded = encodeReply(request, reply, id);
    if (Buffer.byteLength(encoded.body) > outputMaximum)
      throw Error('Response body exceeds byte limit');
    return encoded;
  };
  for (const exchange of options.fixture?.exchanges ?? [])
    boundedReply(exchange.request, exchange.reply, 'request-1000000000');
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const cancellation = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) cancellation.abort();
    });
    void route().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else if (!response.destroyed)
        json(
          response,
          400,
          errorBody(error instanceof Error ? error.message : 'Invalid request', 'invalid_request'),
        );
    });
    async function route() {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/control/')) {
        if (request.headers.authorization !== `Bearer ${controlToken}`) {
          json(response, 401, errorBody('Invalid control credential', 'unauthorized'));
          return;
        }
        if (request.method === 'GET' && url.pathname === '/control/status') {
          json(response, 200, broker.status());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/control/transcript') {
          json(response, 200, broker.transcript());
          return;
        }
        if (request.method === 'GET' && url.pathname === '/control/requests') {
          const waitMs = Number(url.searchParams.get('waitMs') ?? 0);
          if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000)
            throw Error('waitMs must be between 0 and 30000');
          json(response, 200, await broker.wait(waitMs, cancellation.signal));
          return;
        }
        if (request.method === 'GET' && url.pathname.startsWith('/control/requests/')) {
          json(
            response,
            200,
            broker.inspect(decodeURIComponent(url.pathname.slice('/control/requests/'.length))),
          );
          return;
        }
        if (request.method === 'POST' && url.pathname === '/control/responses') {
          if (options.mode !== 'interactive') {
            json(response, 409, errorBody('Fixed mode does not accept operator decisions'));
            return;
          }
          const body = await readBody(request, maximum);
          if (
            !isJsonObject(body) ||
            typeof body.requestId !== 'string' ||
            typeof body.decisionId !== 'string'
          )
            throw Error('requestId and decisionId are required');
          const reply = readReply(body.reply),
            record = broker.inspect(body.requestId);
          boundedReply(record.request, reply, record.id);
          try {
            json(response, 200, broker.respond(body.requestId, body.decisionId, reply));
          } catch (error) {
            json(
              response,
              409,
              errorBody(
                error instanceof Error ? error.message : 'Response conflict',
                'decision_conflict',
              ),
            );
          }
          return;
        }
        if (request.method === 'POST' && url.pathname === '/control/verify') {
          try {
            broker.verify();
            json(response, 200, { ok: true });
          } catch (error) {
            json(
              response,
              409,
              errorBody(
                error instanceof Error ? error.message : 'Verification failed',
                'verification_failed',
              ),
            );
          }
          return;
        }
        if (request.method === 'POST' && url.pathname === '/control/close') {
          json(response, 200, { ok: true });
          setImmediate(() => void close());
          return;
        }
        json(response, 404, errorBody('Unknown control endpoint', 'not_found'));
        return;
      }
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        json(
          response,
          401,
          errorBody('Use the local mock API key from the session descriptor', 'unauthorized'),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        json(response, 200, {
          object: 'list',
          data: [{ id: 'part-mock', object: 'model', created: 0, owned_by: 'part-mock' }],
        });
        return;
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        json(
          response,
          404,
          errorBody('Only /v1/chat/completions and /v1/models are supported', 'not_found'),
        );
        return;
      }
      const body = readChatRequest(await readBody(request, maximum));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let id: string;
      try {
        id = broker.admit(body, (reply) => {
          clearTimeout(timer);
          if (response.destroyed) return;
          const encoded = boundedReply(body, reply, id ?? `request-${broker.status().received}`);
          response.writeHead(encoded.status, {
            'content-type': encoded.contentType,
            'cache-control': 'no-store',
          });
          response.end(encoded.body);
        });
      } catch (error) {
        json(
          response,
          503,
          errorBody(error instanceof Error ? error.message : 'Mock admission failed', 'capacity'),
        );
        return;
      }
      const cancelled = () => {
        clearTimeout(timer);
        broker.end(id, 'cancelled');
      };
      cancellation.signal.addEventListener('abort', cancelled, { once: true });
      response.on('finish', () => {
        clearTimeout(timer);
        cancellation.signal.removeEventListener('abort', cancelled);
      });
      if (cancellation.signal.aborted) cancelled();
      else if (broker.inspect(id).state === 'pending') {
        timer = setTimeout(() => broker.end(id, 'timed-out'), timeout);
        timer.unref();
      }
    }
  });
  async function close(): Promise<void> {
    return (closePromise ??= (async () => {
      broker.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        const timer = setTimeout(() => server.closeAllConnections(), 100);
        timer.unref();
        server.once('close', () => clearTimeout(timer));
      });
    })());
  }
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(options.port ?? 0, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Invalid mock listen address');
  const origin = `http://127.0.0.1:${address.port}`;
  const session: MockSession = {
    schemaVersion: 1,
    mode: options.mode,
    project: structuredClone(options.project),
    baseURL: `${origin}/v1`,
    apiKey,
    controlURL: `${origin}/control`,
    controlToken,
  };
  return {
    closed: new Promise<void>((resolve) => server.once('close', resolve)),
    session,
    pending: broker.pending,
    inspect: broker.inspect,
    respond(id: string, decisionId: string, reply: MockReply) {
      if (options.mode !== 'interactive')
        throw Error('Fixed mode does not accept operator decisions');
      const record = broker.inspect(id);
      boundedReply(record.request, readReply(reply), id);
      return broker.respond(id, decisionId, reply);
    },
    status: broker.status,
    transcript: broker.transcript,
    verify: broker.verify,
    close,
  };
}
