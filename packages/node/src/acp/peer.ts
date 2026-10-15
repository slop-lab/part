import { jsonCodec } from '@slop-lab/part/client/index.js';
import { emptyCleanup, fail, isJson, isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { Contracts } from '@slop-lab/part/reference/index.js';
import { createAcpOutput } from './output.js';
import { AcpRpcError, limit } from './types.js';
import type { AcpHandler, AcpPeer, AcpStdioOptions } from './types.js';

type Id = string | number | null;
const validId = (value: unknown): value is Id =>
  value === null ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isSafeInteger(value));
/** ACP v1 newline-delimited JSON-RPC. Does not import agent/provider implementations. */
export function startJsonRpcPeer(options: AcpStdioOptions & { cancelMethod?: string }): {
  readonly closed: Promise<Contracts.CleanupReport>;
  close(): Promise<Contracts.CleanupReport>;
} {
  const input = options.input ?? process.stdin,
    output = options.output ?? process.stdout;
  const maxFrameBytes = limit(options.maxFrameBytes, 1024 * 1024),
    maxQueuedBytes = limit(options.maxQueuedBytes, 4 * 1024 * 1024);
  const maxPending = limit(options.maxPendingRequests, 32),
    maxConcurrent = limit(options.maxConcurrentRequests, 32),
    timeoutMs = limit(options.requestTimeoutMs, 120000);
  const abort = new AbortController(),
    send = createAcpOutput(
      output,
      abort.signal,
      maxFrameBytes,
      maxQueuedBytes,
      limit(options.writeTimeoutMs, 30000),
    );
  const pending = new Map<
      string,
      { resolve(value: Contracts.Json): void; reject(error: Error): void }
    >(),
    incoming = new Map<Id, AbortController>();
  let handler: AcpHandler,
    ended = false,
    closing: Promise<Contracts.CleanupReport> | undefined;
  let resolveClosed!: (report: Contracts.CleanupReport) => void;
  const closed = new Promise<Contracts.CleanupReport>((resolve) => {
    resolveClosed = resolve;
  });
  const errors: Contracts.Failure[] = [];
  const close = (): Promise<Contracts.CleanupReport> => {
    if (closing) return closing;
    ended = true;
    abort.abort();
    for (const controller of incoming.values()) controller.abort();
    input.destroy();
    for (const request of pending.values())
      request.reject(new AcpRpcError(-32603, 'ACP connection closed'));
    pending.clear();
    return (closing = (async () => {
      let report = emptyCleanup();
      try {
        report = (await handler?.close()) ?? report;
      } catch {
        errors.push(fail('acp.cleanup', 'ACP handler cleanup failed', 'internal').error);
      }
      const result = { ...report, errors: [...report.errors, ...errors] };
      output.off('error', outputFailure);
      resolveClosed(result);
      return result;
    })());
  };
  const outputFailure = () => {
    if (!ended) errors.push(fail('acp.output', 'ACP output stream failed', 'unavailable').error);
    void close();
  };
  output.on('error', outputFailure);
  const write = async (value: Contracts.Json) => {
    try {
      await send(value);
    } catch (error) {
      outputFailure();
      throw error;
    }
  };
  const peer: AcpPeer = {
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    request(method, params, opt = {}) {
      if (ended || opt.signal?.aborted)
        return Promise.reject(new AcpRpcError(-32603, 'ACP request cancelled'));
      if (pending.size >= maxPending)
        return Promise.reject(new AcpRpcError(-32000, 'ACP pending request capacity reached'));
      const waitMs = limit(opt.timeoutMs, timeoutMs),
        id = `part/${crypto.randomUUID()}`;
      return new Promise<Contracts.Json>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: Contracts.Json) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opt.signal?.removeEventListener('abort', cancelled);
          pending.delete(id);
          error ? reject(error) : resolve(value ?? null);
        };
        const cancel = (message: string) => {
          void write({
            jsonrpc: '2.0',
            method: options.cancelMethod ?? '$/cancel_request',
            params: { requestId: id },
          }).catch(() => {});
          finish(new AcpRpcError(-32603, message));
        };
        const cancelled = () => cancel('ACP request cancelled');
        const timer = setTimeout(() => cancel('ACP client request timed out'), waitMs);
        pending.set(id, {
          resolve: (value) => finish(undefined, value),
          reject: (error) => finish(error),
        });
        opt.signal?.addEventListener('abort', cancelled, { once: true });
        void write({ jsonrpc: '2.0', id, method, params }).catch(() =>
          finish(new AcpRpcError(-32603, 'ACP request delivery failed')),
        );
      });
    },
  };
  try {
    handler = options.createHandler(peer);
  } catch (error) {
    output.off('error', outputFailure);
    input.destroy();
    throw error;
  }
  const errorResponse = (id: Id, code: number, message: string, data?: Contracts.Json) =>
    write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  async function frame(bytes: Uint8Array): Promise<void> {
    const decoded = jsonCodec.decode(bytes);
    if (!decoded.ok) {
      await errorResponse(null, -32700, 'Parse error');
      return;
    }
    const message = decoded.value;
    if (!isJsonObject(message) || message.jsonrpc !== '2.0') {
      await errorResponse(null, -32600, 'Invalid request');
      return;
    }
    if (typeof message.method !== 'string') {
      if (
        !Object.hasOwn(message, 'method') &&
        typeof message.id === 'string' &&
        pending.has(message.id)
      ) {
        const request = pending.get(message.id)!;
        if (
          Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error') &&
          Object.hasOwn(message, 'result')
        )
          request.resolve(message.result ?? null);
        else if (
          isJsonObject(message.error) &&
          Number.isSafeInteger(message.error.code) &&
          typeof message.error.message === 'string'
        )
          request.reject(
            new AcpRpcError(Number(message.error.code), 'ACP client rejected the request'),
          );
        else request.reject(new AcpRpcError(-32600, 'Malformed ACP client response'));
      } else if (Object.hasOwn(message, 'method') || !Object.hasOwn(message, 'id'))
        await errorResponse(null, -32600, 'Invalid request');
      // Late responses to cancelled or expired permission requests are intentionally ignored.
      return;
    }
    const request = Object.hasOwn(message, 'id');
    if (
      (request && !validId(message.id)) ||
      (message.params !== undefined && !isJsonObject(message.params))
    ) {
      if (request) await errorResponse(null, -32600, 'Invalid request');
      return;
    }
    const id = request ? (message.id as Id) : null;
    if (request && (incoming.has(id) || incoming.size >= maxConcurrent)) {
      await errorResponse(id, -32000, 'Duplicate request ID or request capacity reached');
      return;
    }
    if (
      !request &&
      message.method === (options.cancelMethod ?? '$/cancel_request') &&
      isJsonObject(message.params) &&
      validId(message.params.requestId)
    ) {
      incoming.get(message.params.requestId)?.abort();
      return;
    }
    const requestAbort = new AbortController();
    if (request) incoming.set(id, requestAbort);
    const releaseRequest = () => {
      if (request && incoming.get(id) === requestAbort) incoming.delete(id);
    };
    void (async () => {
      try {
        const result = await handler.handle(
          message.method as string,
          message.params ?? {},
          request ? 'request' : 'notification',
          requestAbort.signal,
        );
        releaseRequest();
        if (request && !ended) await write({ jsonrpc: '2.0', id, result });
      } catch (error) {
        releaseRequest();
        if (request && !ended) {
          const known =
            error instanceof Error && 'code' in error && Number.isSafeInteger(error.code);
          const code = known ? Number(error.code) : -32603;
          const data =
            error && typeof error === 'object' && 'data' in error && isJson(error.data)
              ? error.data
              : undefined;
          await errorResponse(id, code, known ? error.message : 'Internal error', data);
        }
      } finally {
        releaseRequest();
      }
    })().catch(() => {
      void close();
    });
  }
  void (async () => {
    let parts: Uint8Array[] = [],
      length = 0;
    try {
      for await (const chunk of input) {
        if (ended) break;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset),
            end = newline < 0 ? bytes.length : newline;
          const part = bytes.subarray(offset, end);
          length += part.length;
          if (length > maxFrameBytes)
            throw new AcpRpcError(-32600, 'ACP input frame exceeds limit');
          parts.push(part);
          if (newline < 0) break;
          const line = Buffer.concat(parts, length);
          parts = [];
          length = 0;
          offset = newline + 1;
          if (line.toString('utf8').trim()) await frame(line);
        }
      }
      if (!ended && length) await errorResponse(null, -32700, 'Unfinished JSON-RPC frame');
    } catch {
      if (!ended)
        errors.push(
          fail('acp.input', 'ACP input stream failed or exceeded its frame limit', 'unavailable')
            .error,
        );
    } finally {
      await close();
    }
  })();
  return { closed, close };
}
