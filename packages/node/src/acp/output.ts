import { jsonCodec } from '@part/core/client';
import type { Contracts } from '@part/core/reference';
import type { Writable } from 'node:stream';
import { AcpRpcError } from './types.js';

/** Ordered, bounded writes; abort releases callbacks even when the client stops reading. */
export function createAcpOutput(
  output: Writable,
  signal: AbortSignal,
  maxFrameBytes: number,
  maxQueuedBytes: number,
  writeTimeoutMs: number,
) {
  let tail = Promise.resolve(),
    queued = 0;
  return async (message: Contracts.Json): Promise<void> => {
    if (signal.aborted) throw new AcpRpcError(-32603, 'ACP connection is closed');
    const encoded = jsonCodec.encode(message);
    if (!encoded.ok || encoded.value.length > maxFrameBytes)
      throw new AcpRpcError(-32603, 'ACP output frame exceeds limit');
    const bytes = Buffer.concat([encoded.value, Buffer.from('\n')]);
    if (queued + bytes.length > maxQueuedBytes)
      throw new AcpRpcError(-32603, 'ACP output queue exceeds limit');
    queued += bytes.length;
    const write = tail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            output.off('error', finish);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(
            () => finish(new AcpRpcError(-32603, 'ACP output timed out')),
            writeTimeoutMs,
          );
          const aborted = () => finish(new AcpRpcError(-32603, 'ACP connection is closed'));
          if (signal.aborted) return aborted();
          signal.addEventListener('abort', aborted, { once: true });
          output.once('error', finish);
          try {
            output.write(bytes, finish);
          } catch {
            finish(new AcpRpcError(-32603, 'ACP output failed'));
          }
        }),
    );
    tail = write.catch(() => {});
    try {
      await write;
    } finally {
      queued -= bytes.length;
    }
  };
}
