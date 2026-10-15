import { canonical, fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';
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

export function createResponsesDecoder(response: {
  status?: number;
  headers: Readonly<Record<string, string>>;
}): Contracts.Result<Model.ResponseDecoder> {
  if (response.status !== undefined && (response.status < 200 || response.status >= 300))
    return fail(
      'openai-responses.http',
      `Provider returned HTTP ${response.status}`,
      'unavailable',
    );
  const media = (
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ??
    'text/event-stream'
  )
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!['application/json', 'text/event-stream'].includes(media))
    return fail('openai-responses.media', 'Expected JSON or SSE', 'unsupported');
  const streaming = media === 'text/event-stream',
    utf8 = new TextDecoder('utf-8', { fatal: true });
  const items = new Map<number, StreamItem>();
  let buffer = '',
    lines: string[] = [],
    terminal: Model.Response | undefined,
    poison: Contracts.Failure | undefined,
    responseId: string | undefined,
    sequence = -1,
    finished = false,
    doneMarker = false;

  function consume(value: unknown): Contracts.Result<readonly Model.ProviderEvent[]> {
    if (!isJsonObject(value) || typeof value.type !== 'string')
      return fail('openai-responses.event', 'Invalid event envelope');
    if (terminal) return fail('openai-responses.trailing', 'Event after terminal response');
    if (value.sequence_number !== undefined) {
      if (!Number.isSafeInteger(value.sequence_number) || Number(value.sequence_number) <= sequence)
        return fail('openai-responses.sequence', 'Invalid event sequence');
      sequence = Number(value.sequence_number);
    }
    const type = value.type;
    if (['error', 'response.failed', 'response.incomplete'].includes(type))
      return fail(
        'openai-responses.failed',
        'Provider response failed or was incomplete',
        'unavailable',
      );
    if (['response.created', 'response.in_progress', 'response.completed'].includes(type)) {
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
        if (envelope.status !== 'in_progress' || envelope.error)
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
    if (
      !indexValue(value.output_index) ||
      (typeof value.item_id !== 'string' && !isJsonObject(value.item))
    )
      return fail('openai-responses.event', 'Missing output index or item identity');
    if (type === 'response.output_item.added') {
      const item = value.item;
      if (
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
    const item = items.get(value.output_index);
    if (
      !item ||
      item.id !== (isJsonObject(value.item) ? value.item.id : value.item_id) ||
      item.done
    )
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
    if (
      item.type === 'reasoning' &&
      [
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_part.done',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_text.done',
        'response.reasoning_text.delta',
        'response.reasoning_text.done',
      ].includes(type)
    ) {
      // Only the terminal native item is replayable; partial reasoning is never tool input.
      return ok([]);
    }
    return fail('openai-responses.event', 'Unsupported streaming event', 'unsupported');
  }

  function frame(): Contracts.Result<readonly Model.ProviderEvent[]> {
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    const event = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice(6).trim());
    lines = [];
    if (!data) return ok([]);
    if (doneMarker) return fail('openai-responses.trailing', 'Data after [DONE]');
    if (data === '[DONE]') {
      if (!terminal) return fail('openai-responses.eof', '[DONE] without completed response');
      doneMarker = true;
      return ok([]);
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return fail('openai-responses.json', 'Malformed SSE JSON');
    }
    if (event.length > 1 || (event[0] && (!isJsonObject(value) || event[0] !== value.type)))
      return fail('openai-responses.event', 'SSE event name disagrees with payload');
    return consume(value);
  }

  function drain(flush: boolean): Contracts.Result<readonly Model.ProviderEvent[]> {
    const events: Model.ProviderEvent[] = [];
    while (buffer.length) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!flush && index === buffer.length - 1 && buffer[index] === '\r')) break;
      const line = buffer.slice(0, index),
        width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + width);
      if (line) lines.push(line);
      else {
        const parsed = frame();
        if (!parsed.ok) return parsed;
        events.push(...parsed.value);
      }
    }
    if (flush && (buffer.trim() || lines.some((line) => line.startsWith('data:'))))
      return fail('openai-responses.frame', 'Incomplete SSE frame');
    return ok(events);
  }
  return ok({
    push(chunk) {
      if (poison) return { ok: false, error: poison };
      if (finished) return fail('openai-responses.finished', 'Decoder already finished');
      try {
        buffer += utf8.decode(chunk, { stream: true });
        const result = streaming ? drain(false) : ok([]);
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
        buffer += utf8.decode();
        if (!streaming) return decodeOutput(JSON.parse(buffer));
        const drained = drain(true);
        if (!drained.ok) return drained;
        return terminal ? ok(terminal) : fail('openai-responses.eof', 'Missing response.completed');
      } catch {
        return fail('openai-responses.decode', 'Malformed JSON or UTF-8');
      }
    },
  });
}
