import { fail, freeze, ok } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
import type { Projection } from '../reference/projection.js';
import { partKey } from './parts.js';
export function createController(port: Client.Port): Client.Controller & {
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
