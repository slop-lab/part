import { fail, isJson, ok } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
import type { Contracts } from '../reference/contracts.js';
import type { Projection } from '../reference/projection.js';
import { createProgress } from '../runtime/progress.js';
import { clearItemParts, partKey } from './parts.js';
export function createWatchHub(
  capabilities: Contracts.CapabilitySet,
  initialItems: readonly Projection.Item[] = [],
) {
  let epoch = crypto.randomUUID(),
    sequence = 0,
    audienceRevision = '0';
  const streamId = crypto.randomUUID();
  const items = new Map(initialItems.map((item) => [item.id, structuredClone(item)])),
    parts = new Map<string, Client.StreamPartSnapshot>(),
    progress = createProgress();
  const snapshot = (): Client.Snapshot => ({
    epoch,
    streamId,
    throughSequence: sequence,
    cursor: `${epoch}/${sequence}`,
    audienceRevision,
    items: structuredClone([...items.values()]),
    streamingParts: structuredClone([...parts.values()]),
    capabilities: structuredClone(capabilities),
  });
  const emit = (
    type: string,
    payload: Contracts.Json,
    persistence: Client.EventEnvelope['persistence'] = 'state-backed',
    clearStreamingParts = false,
  ) => {
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      epoch = crypto.randomUUID();
      sequence = 0;
      progress.publish('frame', {
        kind: 'reset',
        snapshot: snapshot(),
      } as unknown as Contracts.Json);
    }
    const event: Client.EventEnvelope = {
      protocolVersion: 1,
      epoch,
      streamId,
      sequence: ++sequence,
      cursor: `${epoch}/${sequence}`,
      type,
      schemaVersion: 1,
      persistence,
      payload,
      ...(clearStreamingParts ? { clearStreamingParts: true } : {}),
    };
    progress.publish('frame', { kind: 'event', event } as unknown as Contracts.Json);
  };
  return {
    snapshot,
    close: () => progress.end(),
    upsert(item: Projection.Item, options: { clearStreamingParts?: boolean } = {}) {
      if (!isJson(item)) throw new TypeError('Public item must be JSON');
      items.set(item.id, structuredClone(item));
      if (options.clearStreamingParts) clearItemParts(parts, item.id);
      emit(
        'part.item/upsert',
        item as unknown as Contracts.Json,
        'state-backed',
        options.clearStreamingParts,
      );
    },
    remove(id: string) {
      items.delete(id);
      clearItemParts(parts, id);
      emit('part.item/remove', { id });
    },
    delta(delta: Client.TextDelta) {
      if (
        !Number.isSafeInteger(delta.offset) ||
        delta.offset < 0 ||
        typeof delta.text !== 'string' ||
        !Number.isSafeInteger(delta.offset + delta.text.length)
      )
        return fail('stream.offset', 'Invalid delta offset');
      const key = partKey(delta.itemId, delta.partId),
        current = parts.get(key);
      if (
        (current && (current.generation !== delta.generation || current.offset !== delta.offset)) ||
        (!current && delta.offset !== 0)
      )
        return fail('stream.offset', 'Invalid generation or offset', 'conflict');
      const value: Client.StreamPartSnapshot = {
        ...delta,
        text: (current?.text ?? '') + delta.text,
        offset: delta.offset + delta.text.length,
        completed: false,
      };
      parts.set(key, value);
      emit('part.text/delta', delta as unknown as Contracts.Json, 'delta');
      return ok(undefined);
    },
    reset(nextItems: readonly Projection.Item[], nextAudienceRevision: string) {
      items.clear();
      parts.clear();
      for (const item of nextItems) items.set(item.id, structuredClone(item));
      audienceRevision = nextAudienceRevision;
      progress.publish('frame', {
        kind: 'reset',
        snapshot: snapshot(),
      } as unknown as Contracts.Json);
    },
    async watch(
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Client.WatchSession>> {
      if (context.signal.aborted)
        return fail('watch.cancelled', 'Observation cancelled', 'cancelled');
      const iterator = progress.observe({ signal: context.signal })[Symbol.asyncIterator](),
        bootstrap = snapshot();
      return ok({
        bootstrap,
        frames: {
          async *[Symbol.asyncIterator]() {
            while (true) {
              const next = await iterator.next();
              if (next.done) return;
              if (next.value.kind === 'gap')
                yield {
                  kind: 'gap',
                  recovery: 'snapshot',
                  reason: 'Slow observer exceeded buffer',
                };
              else yield next.value.payload as unknown as Client.StreamFrame;
            }
          },
        },
        async close() {
          await iterator.return?.();
        },
      });
    },
  };
}
