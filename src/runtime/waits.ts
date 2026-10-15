import { canonical, fail, isJson, ok } from '../foundation/contracts.js';
import { scheduleDeadline } from '../foundation/deadline.js';
import type { Contracts, Runtime } from '../reference/index.js';

interface Waiting {
  ticket: Runtime.WaitTicket;
  spec: Runtime.WaitSpec<unknown>;
  principal: Contracts.InvocationContext['principal'];
  result?: unknown;
  commands: Map<string, string>;
  listeners: Set<() => void>;
  cleanup(): void;
}
export function createSuspensions(
  options: {
    authorize?: (ticket: Runtime.WaitTicket, context: Contracts.InvocationContext) => boolean;
  } = {},
): Runtime.SuspensionPort & {
  get(id: string): Contracts.Result<Runtime.WaitTicket>;
  cancel(id: string): Contracts.Result<Runtime.WaitTicket>;
} {
  const entries = new Map<string, Waiting>();
  const touch = (entry: Waiting, state: Runtime.WaitTicket['state']) => {
    entry.ticket = { ...entry.ticket, state, revision: String(Number(entry.ticket.revision) + 1) };
    if (state !== 'open') entry.cleanup();
    for (const listener of entry.listeners) listener();
  };
  const get = (id: string) => {
    const entry = entries.get(id);
    return entry ? ok({ ...entry.ticket }) : fail('wait.missing', id);
  };
  return {
    get,
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return fail('wait.missing', id);
      if (entry.ticket.state === 'open') touch(entry, 'cancelled');
      return get(id);
    },
    async open(spec, context) {
      if (spec.resume)
        return fail('wait.resume', 'Durable handlers are not installed', 'unsupported');
      if (context.signal.aborted) return fail('wait.cancelled', 'Owner is cancelled', 'cancelled');
      const expires = Math.min(
        spec.expiresAt ? Date.parse(spec.expiresAt) : Infinity,
        context.deadline ? Date.parse(context.deadline) : Infinity,
      );
      if (Number.isNaN(expires) || expires <= Date.now())
        return fail('wait.expired', 'Invalid or elapsed expiry', 'timeout');
      const ticket: Runtime.WaitTicket = {
        id: crypto.randomUUID(),
        revision: '0',
        type: spec.type,
        state: 'open',
        durability: 'memory',
      };
      let cancelTimer: (() => void) | undefined;
      const abort = () => touch(entry, 'cancelled');
      const entry: Waiting = {
        ticket,
        spec: {
          ...spec,
          ...(Number.isFinite(expires) ? { expiresAt: new Date(expires).toISOString() } : {}),
        },
        principal: { ...context.principal },
        commands: new Map(),
        listeners: new Set(),
        cleanup() {
          cancelTimer?.();
          context.signal.removeEventListener('abort', abort);
        },
      };
      entries.set(ticket.id, entry);
      context.signal.addEventListener('abort', abort, { once: true });
      if (Number.isFinite(expires))
        cancelTimer = scheduleDeadline(expires, () => touch(entry, 'expired'));
      return ok({ ...ticket });
    },
    async respond(ticket, response, commandId, context) {
      const entry = entries.get(ticket.id);
      if (!entry) return fail('wait.missing', ticket.id);
      const authorized = options.authorize
        ? options.authorize(entry.ticket, context)
        : context.principal.subject === entry.principal.subject &&
          context.principal.authority === entry.principal.authority;
      if (!authorized) return fail('wait.permission', 'Response is not authorized', 'permission');
      if (context.signal.aborted)
        return fail('wait.cancelled', 'Response context is cancelled', 'cancelled');
      if (!isJson(response)) return fail('wait.response', 'Response must be lossless JSON');
      const encoded = canonical(response),
        old = entry.commands.get(commandId);
      if (old !== undefined)
        return old === encoded
          ? ok({ ...entry.ticket })
          : fail('wait.dedupe', 'Command ID has different content', 'conflict');
      if (entry.ticket.state !== 'open')
        return fail('wait.closed', `Ticket is ${entry.ticket.state}`, 'conflict');
      if (entry.ticket.revision !== ticket.revision || ticket.type !== entry.ticket.type)
        return fail('wait.revision', 'Ticket revision mismatch', 'conflict');
      if (entry.spec.expiresAt && Date.parse(entry.spec.expiresAt) <= Date.now()) {
        touch(entry, 'expired');
        return fail('wait.expired', 'Ticket expired', 'timeout');
      }
      const checked = entry.spec.responseSchema.validate(response);
      if (!checked.ok) return fail('wait.response', 'Response schema validation failed');
      entry.result = structuredClone(checked.value);
      entry.commands.set(commandId, encoded);
      touch(entry, 'resolved');
      return ok({ ...entry.ticket });
    },
    async wait(ticket, schema, context) {
      const entry = entries.get(ticket.id);
      if (!entry) return fail('wait.missing', ticket.id);
      if (
        schema.ref.id !== entry.spec.responseSchema.ref.id ||
        schema.ref.version !== entry.spec.responseSchema.ref.version
      )
        return fail('wait.schema', 'Response schema mismatch');
      if (context.signal.aborted) return fail('wait.cancelled', 'Wait cancelled', 'cancelled');
      if (entry.ticket.state === 'open')
        await new Promise<void>((resolve) => {
          const wake = () => {
            context.signal.removeEventListener('abort', wake);
            entry.listeners.delete(wake);
            resolve();
          };
          entry.listeners.add(wake);
          context.signal.addEventListener('abort', wake, { once: true });
        });
      if (context.signal.aborted) return fail('wait.cancelled', 'Wait cancelled', 'cancelled');
      if (entry.ticket.state !== 'resolved')
        return fail(
          'wait.closed',
          `Ticket is ${entry.ticket.state}`,
          entry.ticket.state === 'expired' ? 'timeout' : 'cancelled',
        );
      const checked = schema.validate(structuredClone(entry.result));
      return checked.ok
        ? ok(checked.value)
        : fail('wait.schema', 'Stored response failed schema validation');
    },
  };
}
