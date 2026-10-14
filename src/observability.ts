import type { Contracts as C, Observability as O } from './reference.js';
import { ok, fail, canonical, freeze, isJsonObject, isJson } from './contracts.js';
export function createObservability(options: {
  policy: O.TracePolicy;
  maxExecutions?: number;
  maxEvents?: number;
  redact?: (event: C.Json) => C.Result<C.Json>;
}): O.Service & {
  register(manifest: O.InvocationManifest, context: C.InvocationContext): C.Result<void>;
  record(ref: C.EntityRef, event: C.Json, context: C.InvocationContext): C.Result<void>;
  delete(ref: C.EntityRef, context: C.InvocationContext): C.Result<void>;
} {
  const policy = freeze(structuredClone(options.policy)),
    maxEvents = options.maxEvents ?? 1000;
  if (
    policy.destinations.some((destination) => destination !== 'memory') ||
    (policy.mode === 'redacted' && !options.redact) ||
    (policy.retentionMs !== undefined &&
      (!Number.isSafeInteger(policy.retentionMs) || policy.retentionMs < 1))
  )
    throw new TypeError('Uninstalled trace destination/redactor or invalid retention');
  if (
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    !Number.isSafeInteger(options.maxExecutions ?? 1000) ||
    (options.maxExecutions ?? 1000) < 1
  )
    throw new TypeError('Invalid trace capacity');
  const records = new Map<
    string,
    {
      manifest: O.InvocationManifest;
      principal: string;
      expires: number;
      events: { sequence: number; value: C.Json }[];
      next: number;
    }
  >();
  const key = (ref: C.EntityRef) => canonical(ref as unknown as C.Json);
  const lookup = (ref: C.EntityRef, context: C.InvocationContext) => {
    const record = records.get(key(ref));
    if (record && record.expires <= Date.now()) {
      records.delete(key(ref));
      return undefined;
    }
    return record?.principal === canonical(context.principal) ? record : undefined;
  };
  return {
    register(manifest, context) {
      if (
        !isJson(manifest) ||
        canonical(manifest.tracePolicy as unknown as C.Json) !==
          canonical(policy as unknown as C.Json)
      )
        return fail('trace.manifest', 'Invalid manifest or trace policy mismatch');
      for (const [id, record] of records) if (record.expires <= Date.now()) records.delete(id);
      const id = key(manifest.execution);
      if (records.has(id))
        return fail('trace.duplicate', 'Invocation manifest already registered', 'conflict');
      if (records.size >= (options.maxExecutions ?? 1000))
        return fail('trace.capacity', 'Manifest retention capacity reached');
      records.set(id, {
        manifest: freeze(structuredClone(manifest)),
        principal: canonical(context.principal),
        expires: Date.now() + (policy.retentionMs ?? Infinity),
        events: [],
        next: 1,
      });
      return ok(undefined);
    },
    record(ref, event, context) {
      const record = lookup(ref, context);
      if (!record) return fail('trace.permission', 'Trace access denied', 'permission');
      if (policy.mode === 'none') return ok(undefined);
      if (!isJsonObject(event)) return fail('trace.event', 'Trace event must be a JSON object');
      let value: C.Json;
      if (policy.mode === 'metadata') {
        const safe: Record<string, C.Json> = {};
        for (const field of [
          'type',
          'timestamp',
          'operationId',
          'attemptId',
          'requestId',
          'phase',
          'effect',
          'digest',
          'component',
          'revision',
        ])
          if (typeof event[field] === 'string' || typeof event[field] === 'number')
            safe[field] = event[field]!;
        value = safe;
      } else {
        const selected: Record<string, C.Json> = { ...structuredClone(event) };
        if (!policy.captureRequestBody) delete selected.requestBody;
        if (!policy.captureToolOutput) delete selected.toolOutput;
        if (policy.mode === 'redacted') {
          const result = options.redact!(selected);
          if (!result.ok) return result;
          if (!isJson(result.value))
            return fail('trace.redaction', 'Redactor returned invalid JSON');
          value = result.value;
        } else value = selected;
      }
      record.events.push({ sequence: record.next++, value: freeze(structuredClone(value)) });
      if (record.events.length > maxEvents) record.events.shift();
      return ok(undefined);
    },
    async manifest(ref, context) {
      const record = lookup(ref, context);
      return record
        ? ok(record.manifest)
        : fail('trace.permission', 'Manifest unavailable', 'permission');
    },
    async readTrace(ref, cursor, context) {
      const record = lookup(ref, context);
      if (!record) return fail('trace.permission', 'Trace unavailable', 'permission');
      const after = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(after) || after < 0 || after >= record.next)
        return fail('trace.cursor', 'Invalid trace cursor');
      if (after && record.events[0] && after < record.events[0].sequence - 1)
        return fail('trace.retention', 'Trace cursor expired', 'conflict');
      const events = record.events.filter((event) => event.sequence > after);
      return ok({
        items: events.map((event) => structuredClone(event.value)),
        ...(events.length ? { nextCursor: String(events.at(-1)!.sequence) } : {}),
      });
    },
    delete(ref, context) {
      if (!lookup(ref, context))
        return fail('trace.permission', 'Trace access denied', 'permission');
      records.delete(key(ref));
      return ok(undefined);
    },
  };
}
