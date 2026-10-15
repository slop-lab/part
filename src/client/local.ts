import { fail, ok } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
import type { Contracts } from '../reference/contracts.js';
import { jsonCodec } from './codec.js';
/** Trusted host context is supplied out-of-band and never decoded from a request. */
export function createLocalPort(
  endpoint: Client.Endpoint,
  hostContext: () => Contracts.InvocationContext,
  options: { codecLoopback?: boolean; codec?: Client.Codec } = {},
): Client.Port {
  const codec = options.codec ?? jsonCodec;
  const roundtrip = <T>(value: T): Contracts.Result<T> => {
    if (!options.codecLoopback) return ok(value);
    const bytes = codec.encode(value as Contracts.Json);
    if (!bytes.ok) return bytes;
    const decoded = codec.decode(bytes.value);
    return decoded.ok ? ok(decoded.value as T) : decoded;
  };
  const host = (signal?: AbortSignal) => {
    const context = hostContext();
    return {
      ...context,
      signal: signal ? AbortSignal.any([context.signal, signal]) : context.signal,
    };
  };
  return {
    async command(request, options) {
      if (options?.signal?.aborted)
        return {
          kind: 'not-sent',
          commandId: request.commandId,
          error: {
            code: 'part.client.cancelled',
            category: 'cancelled',
            message: 'Command not sent',
            retry: 'never',
          },
        };
      const encoded = roundtrip(request);
      if (!encoded.ok)
        return { kind: 'not-sent', commandId: request.commandId, error: encoded.error };
      try {
        const response = roundtrip(await endpoint.command(encoded.value, host(options?.signal)));
        return response.ok
          ? { kind: 'receipt', receipt: response.value }
          : {
              kind: 'unknown',
              commandId: request.commandId,
              error: response.error,
              recovery: 'same-key-retry',
            };
      } catch {
        return {
          kind: 'unknown',
          commandId: request.commandId,
          error: {
            code: 'part.client.delivery',
            category: 'unavailable',
            message: 'Command receipt unavailable',
            retry: 'after-reconciliation',
          },
          recovery: 'same-key-retry',
        };
      }
    },
    async query(request, options) {
      const encoded = roundtrip(request);
      if (!encoded.ok) return encoded;
      try {
        const response = roundtrip(await endpoint.query(encoded.value, host(options?.signal)));
        return response.ok ? response.value : response;
      } catch {
        return fail('client.query', 'Query failed', 'unavailable');
      }
    },
    async discover(target) {
      const result = await this.query({
        queryId: 'part/capabilities',
        version: 1,
        input: null,
        ...(target ? { target } : {}),
      });
      return result as Contracts.Result<Contracts.CapabilitySet>;
    },
    async watch(request, options) {
      const encoded = roundtrip(request);
      if (!encoded.ok) return encoded;
      const result = await endpoint.watch(encoded.value, host(options?.signal));
      if (!result.ok) return result;
      const bootstrap = roundtrip(result.value.bootstrap);
      if (!bootstrap.ok) {
        await result.value.close();
        return bootstrap;
      }
      return ok({
        bootstrap: bootstrap.value,
        close: () => result.value.close(),
        frames: {
          async *[Symbol.asyncIterator]() {
            for await (const frame of result.value.frames) {
              const decoded = roundtrip(frame);
              if (!decoded.ok) {
                yield {
                  kind: 'gap' as const,
                  recovery: 'unavailable' as const,
                  reason: 'Frame codec rejected data',
                };
                return;
              }
              yield decoded.value;
            }
          },
        },
      });
    },
  };
}
