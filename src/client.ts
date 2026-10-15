import type { Contracts, Client, Projection } from './reference.js';
import { ok, fail, isJson, isJsonObject, freeze, canonical } from './contracts.js';
import { createProgress } from './runtime.js';
const partKey = (itemId: string, partId: string) => canonical([itemId, partId]);
export const jsonCodec: Client.Codec = {
  encode(value) {
    return isJson(value)
      ? ok(new TextEncoder().encode(JSON.stringify(value)))
      : fail('wire.encode', 'Value is not lossless JSON');
  },
  decode(bytes) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return isJson(value) ? ok(value) : fail('wire.decode', 'Invalid JSON');
    } catch {
      return fail('wire.decode', 'Malformed UTF-8 JSON');
    }
  },
};
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
    };
    progress.publish('frame', { kind: 'event', event } as unknown as Contracts.Json);
  };
  return {
    snapshot,
    close: () => progress.end(),
    upsert(item: Projection.Item) {
      if (!isJson(item)) throw new TypeError('Public item must be JSON');
      items.set(item.id, structuredClone(item));
      emit('part.item/upsert', item as unknown as Contracts.Json);
    },
    remove(id: string) {
      items.delete(id);
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
export function createController(
  port: Client.Port,
): Client.Controller & {
  getPart(itemId: string, partId: string): Client.StreamPartSnapshot | undefined;
} {
  let state: Client.State = { connection: 'offline', itemIds: [], pendingCommands: [] },
    sequence = 0,
    streamId = '',
    session: Client.WatchSession | undefined,
    generation = 0,
    disposed = false;
  const items = new Map<string, Projection.Item>(),
    parts = new Map<string, Client.StreamPartSnapshot>(),
    listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A view subscriber cannot interrupt owner commands. */
      }
    }
  };
  const reset = (snapshot: Client.Snapshot) => {
    items.clear();
    parts.clear();
    for (const item of snapshot.items) items.set(item.id, freeze(structuredClone(item)));
    for (const part of snapshot.streamingParts)
      parts.set(partKey(part.itemId, part.partId), freeze(structuredClone(part)));
    sequence = snapshot.throughSequence;
    streamId = snapshot.streamId;
    state = {
      ...state,
      epoch: snapshot.epoch,
      itemIds: [...items.keys()],
      connection: 'connected',
    };
    notify();
  };
  const controller: Client.Controller & {
    getPart(itemId: string, partId: string): Client.StreamPartSnapshot | undefined;
  } = {
    port,
    getState: () =>
      freeze({
        ...state,
        itemIds: [...state.itemIds],
        pendingCommands: [...state.pendingCommands],
      }),
    getItem: (id) => items.get(id),
    getPart: (itemId, partId) => parts.get(partKey(itemId, partId)),
    subscribe(selector, listener) {
      let previous = selector.select(controller.getState(), controller.getItem);
      const onChange = () => {
        const next = selector.select(controller.getState(), controller.getItem);
        if (!selector.equal(previous, next)) {
          previous = next;
          listener(next);
        }
      };
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    async connect(request) {
      if (disposed) return fail('client.disposed', 'Controller disposed', 'conflict');
      await controller.disconnect();
      const current = ++generation;
      state = { ...state, connection: 'connecting' };
      notify();
      const result = await port.watch(request);
      if (!result.ok) {
        state = { ...state, connection: 'offline' };
        notify();
        return result;
      }
      if (current !== generation || disposed) {
        await result.value.close();
        return fail('client.stale', 'Connection superseded', 'conflict');
      }
      session = result.value;
      reset(session.bootstrap);
      void (async () => {
        try {
          for await (const frame of result.value.frames) {
            if (current !== generation) break;
            if (frame.kind === 'reset') {
              reset(frame.snapshot);
              continue;
            }
            let resync = frame.kind === 'gap';
            if (frame.kind === 'event') {
              const event = frame.event;
              if (
                event.protocolVersion !== 1 ||
                event.schemaVersion !== 1 ||
                event.epoch !== state.epoch ||
                event.streamId !== streamId ||
                !Number.isSafeInteger(event.sequence) ||
                event.sequence > sequence + 1
              )
                resync = true;
              else if (event.sequence <= sequence) continue;
              else {
                sequence = event.sequence;
                if (event.type === 'part.item/upsert') {
                  const item = event.payload as unknown as Projection.Item;
                  items.set(item.id, freeze(structuredClone(item)));
                  state = { ...state, itemIds: [...items.keys()] };
                }
                if (event.type === 'part.item/remove') {
                  items.delete((event.payload as { id: string }).id);
                  state = { ...state, itemIds: [...items.keys()] };
                }
                if (event.type === 'part.text/delta') {
                  const delta = event.payload as unknown as Client.TextDelta,
                    key = partKey(delta.itemId, delta.partId),
                    old = parts.get(key);
                  if (
                    !Number.isSafeInteger(delta.offset) ||
                    delta.offset < 0 ||
                    typeof delta.text !== 'string' ||
                    !Number.isSafeInteger(delta.offset + delta.text.length) ||
                    (old && (old.generation !== delta.generation || old.offset !== delta.offset)) ||
                    (!old && delta.offset !== 0)
                  )
                    resync = true;
                  else
                    parts.set(
                      key,
                      freeze({
                        ...delta,
                        text: (old?.text ?? '') + delta.text,
                        offset: delta.offset + delta.text.length,
                        completed: false,
                      }),
                    );
                }
                notify();
              }
            }
            if (resync) {
              state = { ...state, connection: 'resyncing' };
              notify();
              await controller.connect(request);
              break;
            }
          }
        } catch {
          if (current === generation) {
            state = { ...state, connection: 'offline' };
            notify();
          }
        }
      })();
      return ok(undefined);
    },
    async disconnect() {
      generation++;
      const previous = session;
      session = undefined;
      await previous?.close();
      state = { ...state, connection: 'offline' };
      notify();
    },
    async invoke(request) {
      if (disposed)
        return {
          kind: 'not-sent',
          commandId: request.commandId,
          error: {
            code: 'part.client.disposed',
            category: 'conflict',
            message: 'Controller disposed',
            retry: 'never',
          },
        };
      state = { ...state, pendingCommands: [...state.pendingCommands, request.commandId] };
      notify();
      const delivery = await port.command(request);
      if (delivery.kind !== 'unknown')
        state = {
          ...state,
          pendingCommands: state.pendingCommands.filter((id) => id !== request.commandId),
        };
      notify();
      return delivery;
    },
    async dispose() {
      if (!disposed) {
        disposed = true;
        await controller.disconnect();
        listeners.clear();
      }
    },
  };
  return controller;
}
