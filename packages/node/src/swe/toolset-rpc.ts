import { isJson, isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { Contracts } from '@slop-lab/part/reference/index.js';

export type ToolsetRpcOptions = {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
};

export class ToolsetRpcError extends Error {
  readonly name = 'ToolsetRpcError';
  constructor(
    message: string,
    readonly code: string,
    readonly details: Contracts.Json,
    readonly sent: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ToolsetRpc = (
  method: string,
  params: Contracts.Json,
  signal: AbortSignal,
) => Promise<Contracts.Json>;

export function createToolsetRpc(options: ToolsetRpcOptions): ToolsetRpc {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new ToolsetRpcError('Toolset endpoint must use HTTP', 'ENDPOINT', null, false);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    (endpoint.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
  )
    throw new ToolsetRpcError(
      'Toolset credentials require HTTPS or a loopback HTTP endpoint',
      'ENDPOINT',
      null,
      false,
    );
  if (!options.token)
    throw new ToolsetRpcError('Toolset bearer token is required', 'TOKEN', null, false);
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new ToolsetRpcError('Toolset request timeout is invalid', 'TIMEOUT', timeoutMs, false);
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw new ToolsetRpcError(
      'Toolset response limit is invalid',
      'RESPONSE_LIMIT',
      maxResponseBytes,
      false,
    );

  return async (method, params, signal) => {
    if (signal.aborted)
      throw new ToolsetRpcError(
        'Toolset request was cancelled before send',
        'CANCELLED',
        null,
        false,
      );
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await request(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method, params }),
        signal: combined,
        redirect: 'error',
      });
    } catch (error) {
      throw new ToolsetRpcError(
        combined.aborted
          ? 'Toolset request was cancelled or timed out'
          : 'Toolset response was lost',
        combined.aborted ? 'CANCELLED' : 'RESPONSE_LOST',
        null,
        true,
        { cause: error },
      );
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof ToolsetRpcError) throw error;
      throw new ToolsetRpcError('Toolset returned invalid JSON', 'INVALID_JSON', null, true, {
        cause: error,
      });
    }
    if (!isJsonObject(payload))
      throw new ToolsetRpcError(
        'Toolset returned an invalid envelope',
        'INVALID_ENVELOPE',
        null,
        true,
      );
    if (!response.ok || Object.hasOwn(payload, 'error')) {
      const remote = payload.error;
      const code =
        isJsonObject(remote) && typeof remote.code === 'string' ? remote.code : 'RPC_ERROR';
      throw new ToolsetRpcError('Toolset RPC failed', code, payload, true);
    }
    if (!Object.hasOwn(payload, 'result') || !isJson(payload.result))
      throw new ToolsetRpcError(
        'Toolset result is not lossless JSON',
        'INVALID_RESULT',
        payload,
        true,
      );
    return structuredClone(payload.result);
  };
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum)
    throw new ToolsetRpcError(
      'Toolset response exceeded byte limit',
      'RESPONSE_LIMIT',
      declared,
      true,
    );
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new ToolsetRpcError(
        'Toolset response exceeded byte limit',
        'RESPONSE_LIMIT',
        bytes,
        true,
      );
    }
    chunks.push(chunk.value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(merged));
}
