import { fail, isJson, ok } from '../contracts/index.js';
import type { Runtime } from '../reference/runtime.js';
/** A bounded multicast stream. Readers never own execution. */
export function createProgress(defaultCapacity = 64) {
  let index = 0,
    ended = false;
  type Reader = { queue: Runtime.Update[]; wake?: () => void; capacity: number; closed: boolean };
  const readers = new Set<Reader>();
  const publish: Runtime.ProgressSink['publish'] = (type, payload) => {
    if (ended) return ok({ accepted: false, dropped: 0 });
    if (!isJson(payload)) return fail('progress.payload', 'Progress payload must be lossless JSON');
    const update: Runtime.Update = {
      kind: 'data',
      index: ++index,
      type,
      payload: structuredClone(payload),
    };
    let dropped = 0;
    for (const reader of readers) {
      if (reader.queue.length >= reader.capacity) {
        const old = reader.queue.splice(0);
        const first = old[0]!;
        reader.queue.push({
          kind: 'gap',
          from: first.kind === 'gap' ? first.from : first.index,
          to: index - 1,
          recovery: 'snapshot',
        });
        dropped += old.length;
      }
      reader.queue.push(update);
      reader.wake?.();
      reader.wake = undefined;
    }
    return ok({ accepted: true, dropped });
  };
  return {
    publish,
    end() {
      ended = true;
      for (const reader of readers) reader.wake?.();
    },
    observe(
      options: { signal?: AbortSignal; bufferSize?: number } = {},
    ): AsyncIterable<Runtime.Update> {
      return {
        [Symbol.asyncIterator]() {
          const reader: Reader = {
            queue: [],
            capacity: Math.min(
              4096,
              Math.max(
                2,
                Math.floor(
                  Number.isFinite(options.bufferSize ?? defaultCapacity)
                    ? (options.bufferSize ?? defaultCapacity)
                    : 64,
                ),
              ),
            ),
            closed: false,
          };
          readers.add(reader);
          const close = () => {
            reader.closed = true;
            reader.queue.length = 0;
            readers.delete(reader);
            reader.wake?.();
            options.signal?.removeEventListener('abort', close);
          };
          options.signal?.addEventListener('abort', close, { once: true });
          if (options.signal?.aborted) close();
          return {
            async next() {
              while (!reader.closed && !reader.queue.length && !ended)
                await new Promise<void>((resolve) => {
                  reader.wake = resolve;
                });
              const value = reader.queue.shift();
              if (value) return { done: false as const, value: structuredClone(value) };
              close();
              return { done: true as const, value: undefined };
            },
            async return() {
              close();
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },
  };
}
