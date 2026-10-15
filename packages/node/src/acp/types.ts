import type { Contracts } from '@part/core/reference';
import type { Readable, Writable } from 'node:stream';

export interface AcpPeer {
  notify(method: string, params: Contracts.Json): Promise<void>;
  request(
    method: string,
    params: Contracts.Json,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Contracts.Json>;
}
export interface AcpHandler {
  handle(
    method: string,
    params: Contracts.Json,
    kind?: 'request' | 'notification',
    signal?: AbortSignal,
  ): Promise<Contracts.Json>;
  close(): Promise<Contracts.CleanupReport>;
}
export interface AcpStdioOptions {
  readonly createHandler: (peer: AcpPeer) => AcpHandler;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly maxFrameBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxConcurrentRequests?: number;
  readonly maxQueuedBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly writeTimeoutMs?: number;
}
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Contracts.Json,
  ) {
    super(message);
    this.name = 'AcpRpcError';
  }
}
export function limit(value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > 2147483647)
    throw new TypeError('Invalid ACP transport limit');
  return chosen;
}
