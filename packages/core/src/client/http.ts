/** @public */
import { fail, isJsonObject, ok } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
import type { Contracts } from '../reference/contracts.js';
import { jsonCodec } from './codec.js';
import { commandSchema, querySchema } from './control.js';
export function createHttpPort(
  baseUrl: string,
  options: {
    fetch?: typeof fetch;
    headers?: () => Readonly<Record<string, string>>;
    maxFrameBytes?: number;
  } = {},
): Client.Port {
  const send = async (path: string, value: Contracts.Json, signal?: AbortSignal) => {
    const encoded = jsonCodec.encode(value);
    if (!encoded.ok) return encoded;
    const response = await (options.fetch ?? fetch)(
      new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers?.() },
        body: Uint8Array.from(encoded.value),
        ...(signal ? { signal } : {}),
        redirect: 'error',
      },
    );
    return ok(response);
  };
  const read = async <T>(response: Response): Promise<Contracts.Result<T>> => {
    if (!response.ok)
      return fail(
        'http.status',
        `Endpoint returned HTTP ${response.status}`,
        response.status === 403 ? 'permission' : 'unavailable',
      );
    const decoded = jsonCodec.decode(new Uint8Array(await response.arrayBuffer()));
    return decoded as Contracts.Result<T>;
  };
  return {
    async command(request, opt) {
      if (opt?.signal?.aborted || !commandSchema.validate(request).ok)
        return {
          kind: 'not-sent',
          commandId: request.commandId,
          error: fail('http.not-sent', 'Command cancelled or invalid').error,
        };
      try {
        const response = await send('commands', request as unknown as Contracts.Json, opt?.signal);
        if (!response.ok)
          return { kind: 'not-sent', commandId: request.commandId, error: response.error };
        const receipt = await read<Contracts.CommandReceipt>(response.value);
        return receipt.ok
          ? { kind: 'receipt', receipt: receipt.value }
          : {
              kind: 'unknown',
              commandId: request.commandId,
              error: receipt.error,
              recovery: 'same-key-retry',
            };
      } catch {
        return {
          kind: 'unknown',
          commandId: request.commandId,
          error: fail('http.delivery', 'Command receipt unavailable', 'unavailable', 'unknown')
            .error,
          recovery: 'same-key-retry',
        };
      }
    },
    async query(request, opt) {
      if (!querySchema.validate(request).ok) return fail('http.query', 'Invalid query');
      try {
        const response = await send('queries', request as unknown as Contracts.Json, opt?.signal);
        if (!response.ok) return response;
        const decoded = await read<Contracts.Result<Contracts.Json>>(response.value);
        return decoded.ok ? decoded.value : decoded;
      } catch {
        return fail('http.query', 'Query unavailable', 'unavailable');
      }
    },
    async discover(target) {
      const response = await this.query({
        queryId: 'part/capabilities',
        version: 1,
        input: null,
        ...(target ? { target } : {}),
      });
      return response as Contracts.Result<Contracts.CapabilitySet>;
    },
    async watch(request, opt) {
      const abort = new AbortController(),
        signal = opt?.signal ? AbortSignal.any([abort.signal, opt.signal]) : abort.signal;
      try {
        const sent = await send('events', request as unknown as Contracts.Json, signal);
        if (!sent.ok) return sent;
        if (!sent.value.ok || !sent.value.body)
          return fail('http.watch', 'Event endpoint unavailable', 'unavailable');
        const reader = sent.value.body.getReader(),
          utf8 = new TextDecoder('utf-8', { fatal: true });
        let buffered = '',
          ended = false;
        const nextFrame = async (): Promise<Contracts.Result<Contracts.Json | undefined>> => {
          while (true) {
            const boundary = buffered.indexOf('\n\n');
            if (boundary >= 0) {
              const frame = buffered.slice(0, boundary);
              buffered = buffered.slice(boundary + 2);
              const data = frame
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trimStart())
                .join('\n');
              if (!data) continue;
              return jsonCodec.decode(new TextEncoder().encode(data));
            }
            const chunk = await reader.read();
            if (chunk.done) {
              ended = true;
              return buffered.trim() ? fail('http.eof', 'Incomplete event frame') : ok(undefined);
            }
            buffered += utf8.decode(chunk.value, { stream: true });
            if (
              new TextEncoder().encode(buffered).byteLength > (options.maxFrameBytes ?? 1024 * 1024)
            )
              return fail('http.frame-size', 'Event frame too large');
          }
        };
        const first = await nextFrame();
        if (!first.ok || !isJsonObject(first.value) || first.value.kind !== 'bootstrap') {
          await reader.cancel();
          return fail('http.bootstrap', 'Missing event bootstrap');
        }
        const bootstrap = first.value.snapshot as unknown as Client.Snapshot;
        return ok({
          bootstrap,
          async close() {
            abort.abort();
            try {
              await reader.cancel();
            } catch {}
          },
          frames: {
            async *[Symbol.asyncIterator]() {
              try {
                while (!ended) {
                  const frame = await nextFrame();
                  if (!frame.ok) {
                    yield {
                      kind: 'gap' as const,
                      recovery: 'snapshot' as const,
                      reason: frame.error.message,
                    };
                    return;
                  }
                  if (frame.value === undefined) return;
                  yield frame.value as unknown as Client.StreamFrame;
                }
              } finally {
                try {
                  await reader.cancel();
                } catch {}
                reader.releaseLock();
              }
            },
          },
        });
      } catch {
        return fail('http.watch', 'Event stream unavailable', 'unavailable');
      }
    },
  };
}
