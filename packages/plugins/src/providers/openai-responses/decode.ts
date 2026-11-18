import { canonical, fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';
import { createSseReader } from '../sse.js';
import { decodeOutput } from './output.js';

interface StreamItem {
  id: string;
  type: string;
  text: Map<number, string>;
  textDone: Set<number>;
  callId?: string;
  name?: string;
  argumentsDone?: boolean;
  arguments?: string;
  done?: Record<string, Contracts.Json>;
}
const indexValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000;

const lifecycleEvents = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
]);
const failureEvents = new Set([
  'error',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
]);
const reasoningEvents = new Set([
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
]);
const itemEvents = new Set([
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.output_text.annotation.added',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.content_part.added',
  'response.content_part.done',
  ...reasoningEvents,
]);

type ResponseHeaders = Readonly<Record<string, string>>;

function header(headers: ResponseHeaders, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.\[\]-]{1,128}$/.test(value) ? value : undefined;
}

function planFailure(
  response: { status?: number; headers: ResponseHeaders },
  error: unknown,
  status?: number,
) {
  const requestId = safeIdentifier(
    header(response.headers, 'x-request-id') ?? header(response.headers, 'openai-request-id'),
  );
  const code = isJsonObject(error) ? safeIdentifier(error.code) : undefined;
  const param = isJsonObject(error) ? safeIdentifier(error.param) : undefined;
  const failure = fail(
    status === undefined ? 'openai-responses.failed' : 'openai-responses.http',
    status === undefined
      ? 'Provider response failed or was incomplete'
      : `Provider returned HTTP ${status}`,
    status === 401 || status === 403 ? 'permission' : 'unavailable',
  );
  return {
    ok: false as const,
    error: {
      ...failure.error,
      details: {
        ...(status === undefined ? {} : { status }),
        ...(requestId ? { requestId } : {}),
        ...(code ? { code } : {}),
        ...(param ? { param } : {}),
      },
    },
  };
}

function readErrorResponse(
  response: { headers: ResponseHeaders },
  status: number,
): Model.ResponseDecoder {
  // Capture bounded diagnostics, leaving provider prose and tokens out of runtime failures.
  const utf8 = new TextDecoder();
  let buffer = '';
  let length = 0;
  return {
    push(chunk) {
      length += chunk.byteLength;
      if (length > 16_384) return planFailure(response, undefined, status);
      buffer += utf8.decode(chunk, { stream: true });
      return ok([]);
    },
    finish() {
      try {
        const body: unknown = JSON.parse(buffer + utf8.decode());
        return planFailure(response, isJsonObject(body) ? body.error : undefined, status);
      } catch {
        return planFailure(response, undefined, status);
      }
    },
  };
}

export function createResponsesDecoder(
  response: { status?: number; headers: ResponseHeaders },
  chatGPTPlan = false,
): Contracts.Result<Model.ResponseDecoder> {
  const { status } = response;
  if (status !== undefined && (status < 200 || status >= 300)) {
    if (chatGPTPlan) return ok(readErrorResponse(response, status));
    return fail('openai-responses.http', `Provider returned HTTP ${status}`, 'unavailable');
  }
  const media = (header(response.headers, 'content-type') ?? 'text/event-stream')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!['application/json', 'text/event-stream'].includes(media))
    return fail('openai-responses.media', 'Expected JSON or SSE', 'unsupported');
  const streaming = media === 'text/event-stream',
    utf8 = new TextDecoder('utf-8', { fatal: true });
  const items = new Map<number, StreamItem>();
  let buffer = '',
    terminal: Model.Response | undefined,
    poison: Contracts.Failure | undefined,
    responseId: string | undefined,
    sequence = -1,
    finished = false,
    doneMarker = false;

  function consume(value: unknown): Contracts.Result<readonly Model.ProviderEvent[]> {
    if (!isJsonObject(value) || typeof value.type !== 'string')
      return fail('openai-responses.event', 'Invalid event envelope');
    const type = value.type;
    if (['ping', 'keepalive', 'codex.rate_limits', 'codex.response.metadata'].includes(type))
      return ok([]);
    if (!lifecycleEvents.has(type) && !failureEvents.has(type) && !itemEvents.has(type)) {
      // A provider may add auxiliary Responses events. Only known events can
      // mutate the accumulated output, and the completed snapshot is validated.
      return /^response\.[a-zA-Z0-9_.-]+$/.test(type)
        ? ok([])
        : fail('openai-responses.event', 'Unsupported streaming event', 'unsupported');
    }
    if (terminal) return fail('openai-responses.trailing', 'Event after terminal response');
    if (value.sequence_number !== undefined) {
      if (!Number.isSafeInteger(value.sequence_number) || Number(value.sequence_number) <= sequence)
        return fail('openai-responses.sequence', 'Invalid event sequence');
      sequence = Number(value.sequence_number);
    }
    if (failureEvents.has(type)) {
      if (chatGPTPlan) {
        const error =
          type === 'error'
            ? value
            : isJsonObject(value.response)
              ? value.response.error
              : undefined;
        return planFailure(response, error);
      }
      return fail(
        'openai-responses.failed',
        'Provider response failed or was incomplete',
        'unavailable',
      );
    }
    if (lifecycleEvents.has(type)) {
      const envelope = value.response;
      if (
        !isJsonObject(envelope) ||
        typeof envelope.id !== 'string' ||
        !envelope.id ||
        (responseId && envelope.id !== responseId)
      )
        return fail('openai-responses.identity', 'Missing or changed response ID');
      responseId = envelope.id;
      if (type !== 'response.completed') {
        const queued =
          (type === 'response.queued' || type === 'response.created') &&
          envelope.status === 'queued';
        const running = type !== 'response.queued' && envelope.status === 'in_progress';
        if ((!queued && !running) || envelope.error)
          return fail('openai-responses.response', 'Invalid response lifecycle');
        return ok([]);
      }
      const decoded = decodeOutput(envelope);
      if (!decoded.ok) return decoded;
      const output = envelope.output;
      if (!Array.isArray(output)) return fail('openai-responses.response', 'Missing output');
      for (const [index, item] of items) {
        const final = output[index];
        if (
          !isJsonObject(final) ||
          final.id !== item.id ||
          final.type !== item.type ||
          (item.done && canonical(item.done) !== canonical(final)) ||
          (item.arguments !== undefined && item.arguments !== final.arguments) ||
          (item.callId !== undefined && item.callId !== final.call_id) ||
          (item.name !== undefined && item.name !== final.name)
        )
          return fail('openai-responses.mismatch', 'Stream item disagrees with completed response');
        for (const [partIndex, text] of item.text) {
          const part = Array.isArray(final.content) ? final.content[partIndex] : undefined;
          if (!isJsonObject(part) || part.type !== 'output_text' || part.text !== text)
            return fail(
              'openai-responses.mismatch',
              'Stream text disagrees with completed response',
            );
        }
      }
      terminal = decoded.value;
      return ok([]);
    }
    if (type === 'response.output_item.added') {
      const item = value.item;
      if (
        !indexValue(value.output_index) ||
        !isJsonObject(item) ||
        typeof item.id !== 'string' ||
        !item.id ||
        typeof item.type !== 'string' ||
        !['message', 'function_call', 'reasoning'].includes(item.type) ||
        items.has(value.output_index) ||
        [...items.values()].some((current) => current.id === item.id)
      )
        return fail(
          'openai-responses.item',
          'Invalid, duplicate or unsupported stream item',
          'unsupported',
        );
      if (
        item.type === 'function_call' &&
        (typeof item.call_id !== 'string' ||
          !item.call_id ||
          typeof item.name !== 'string' ||
          !item.name)
      )
        return fail('openai-responses.tool', 'Function call identity is missing');
      items.set(value.output_index, {
        id: item.id,
        type: item.type,
        text: new Map(),
        textDone: new Set(),
        ...(item.type === 'function_call'
          ? {
              callId: String(item.call_id),
              name: String(item.name),
              ...(typeof item.arguments === 'string' && item.arguments
                ? { arguments: item.arguments }
                : {}),
            }
          : {}),
      });
      return ok([]);
    }
    const itemId = isJsonObject(value.item) ? value.item.id : value.item_id;
    const index = indexValue(value.output_index)
      ? value.output_index
      : value.output_index === undefined && typeof itemId === 'string'
        ? [...items].find(([, item]) => item.id === itemId)?.[0]
        : undefined;
    if (index === undefined)
      return fail('openai-responses.event', 'Missing or invalid output index');
    const item = items.get(index);
    if (!item || (itemId !== undefined && item.id !== itemId) || item.done)
      return fail('openai-responses.item', 'Unknown, changed or already completed stream item');
    if (type === 'response.output_item.done') {
      if (!isJsonObject(value.item) || value.item.type !== item.type)
        return fail('openai-responses.item', 'Stream item type changed');
      item.done = value.item;
      return ok([]);
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const text = type.endsWith('.delta') ? value.delta : value.text;
      if (item.type !== 'message' || !indexValue(value.content_index) || typeof text !== 'string')
        return fail('openai-responses.text', 'Invalid text fragment');
      if (item.textDone.has(value.content_index))
        return fail('openai-responses.text', 'Text delta or duplicate done after completed text');
      const current = item.text.get(value.content_index);
      if (type.endsWith('.done') && current !== undefined && current !== text)
        return fail('openai-responses.mismatch', 'Text fragments disagree');
      if (type.endsWith('.done')) item.textDone.add(value.content_index);
      item.text.set(value.content_index, type.endsWith('.delta') ? (current ?? '') + text : text);
      return ok(type.endsWith('.delta') ? [{ type: 'text-delta', payload: { text } }] : []);
    }
    if (
      type === 'response.function_call_arguments.delta' ||
      type === 'response.function_call_arguments.done'
    ) {
      const args = type.endsWith('.delta') ? value.delta : value.arguments;
      if (item.type !== 'function_call' || typeof args !== 'string' || item.argumentsDone)
        return fail('openai-responses.arguments', 'Invalid function arguments fragment');
      if (type.endsWith('.done') && item.arguments !== undefined && item.arguments !== args)
        return fail('openai-responses.mismatch', 'Function arguments fragments disagree');
      item.arguments = type.endsWith('.delta') ? (item.arguments ?? '') + args : args;
      if (type.endsWith('.done')) item.argumentsDone = true;
      return ok([]);
    }
    if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      if (
        item.type !== 'message' ||
        !indexValue(value.content_index) ||
        !isJsonObject(value.part) ||
        value.part.type !== 'output_text'
      )
        return fail('openai-responses.content', 'Unsupported content part', 'unsupported');
      if (type.endsWith('.done')) {
        if (
          typeof value.part.text !== 'string' ||
          (item.text.has(value.content_index) &&
            item.text.get(value.content_index) !== value.part.text)
        )
          return fail('openai-responses.mismatch', 'Completed content part disagrees with text');
        item.text.set(value.content_index, value.part.text);
        item.textDone.add(value.content_index);
      }
      return ok([]);
    }
    if (type === 'response.output_text.annotation.added') {
      if (
        item.type !== 'message' ||
        !indexValue(value.content_index) ||
        (value.annotation !== null && !isJsonObject(value.annotation))
      )
        return fail('openai-responses.content', 'Invalid text annotation');
      return ok([]);
    }
    if (item.type === 'reasoning' && reasoningEvents.has(type)) {
      // Only the terminal native item is replayable; partial reasoning is never tool input.
      return ok([]);
    }
    return fail('openai-responses.event', 'Unsupported streaming event', 'unsupported');
  }

  const drain = createSseReader('openai-responses', (data, event) => {
    if (doneMarker) return fail('openai-responses.trailing', 'Data after [DONE]');
    if (data === '[DONE]') {
      if (!terminal) return fail('openai-responses.eof', '[DONE] without completed response');
      doneMarker = true;
      return ok([]);
    }
    const name = event[0];
    if (
      event.length === 1 &&
      (name === 'ping' || name === 'keepalive') &&
      /^(?:ping|keepalive|\[PING\])$/i.test(data.trim())
    )
      return ok([]);
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return fail('openai-responses.json', 'Malformed SSE JSON');
    }
    const payloadType = isJsonObject(value) ? value.type : undefined;
    const explicit = name && name !== 'message' ? name : undefined;
    const decoded =
      event.length > 1 || (explicit && payloadType !== undefined && explicit !== payloadType)
        ? fail('openai-responses.event', 'SSE event name disagrees with payload')
        : consume(
            isJsonObject(value) && payloadType === undefined && explicit
              ? { ...value, type: explicit }
              : value,
          );
    if (decoded.ok) return decoded;
    const eventType = safeIdentifier(payloadType ?? explicit);
    const requestId = safeIdentifier(
      header(response.headers, 'x-request-id') ?? header(response.headers, 'openai-request-id'),
    );
    return {
      ok: false,
      error: {
        ...decoded.error,
        details: {
          ...(isJsonObject(decoded.error.details) ? decoded.error.details : {}),
          ...(eventType ? { eventType } : {}),
          ...(requestId ? { requestId } : {}),
        },
      },
    };
  });

  return ok({
    push(chunk) {
      if (poison) return { ok: false, error: poison };
      if (finished) return fail('openai-responses.finished', 'Decoder already finished');
      try {
        const text = utf8.decode(chunk, { stream: true });
        if (!streaming) buffer += text;
        const result = streaming ? drain(text) : ok([]);
        if (!result.ok) poison = result.error;
        return result;
      } catch {
        const result = fail('openai-responses.utf8', 'Invalid UTF-8');
        poison = result.error;
        return result;
      }
    },
    finish() {
      if (poison) return { ok: false, error: poison };
      if (finished) return fail('openai-responses.finished', 'Decoder already finished');
      finished = true;
      try {
        const text = utf8.decode();
        if (!streaming) return decodeOutput(JSON.parse(buffer + text));
        const drained = drain(text, true);
        if (!drained.ok) return drained;
        return terminal ? ok(terminal) : fail('openai-responses.eof', 'Missing response.completed');
      } catch {
        return fail('openai-responses.decode', 'Malformed JSON or UTF-8');
      }
    },
  });
}
