import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';
import { createSseReader } from '../sse.js';

type Block =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, Contracts.Json>;
      partial: string;
    };

function readBlock(value: unknown): Block | undefined {
  if (!isJsonObject(value)) return;
  if (value.type === 'text' && typeof value.text === 'string')
    return { kind: 'text', text: value.text };
  if (
    value.type === 'tool_use' &&
    typeof value.id === 'string' &&
    value.id &&
    typeof value.name === 'string' &&
    value.name &&
    isJsonObject(value.input)
  )
    return { kind: 'tool', id: value.id, name: value.name, input: value.input, partial: '' };
}

function event(text: string): Model.ProviderEvent[] {
  return text ? [{ type: 'text-delta', payload: { text } }] : [];
}

export function createMessagesDecoder(response: {
  status?: number;
  headers: Readonly<Record<string, string>>;
}): Contracts.Result<Model.ResponseDecoder> {
  if (response.status !== undefined && (response.status < 200 || response.status >= 300))
    return fail('anthropic.http', `Provider returned HTTP ${response.status}`, 'unavailable');
  const media =
    Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ??
    'text/event-stream';
  const streaming = media.includes('text/event-stream');
  if (!streaming && !media.includes('application/json'))
    return fail('anthropic.media', 'Expected JSON or SSE', 'unsupported');

  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const blocks: { block: Block; closed: boolean }[] = [];
  let usage: Record<string, Contracts.Json> = {};
  let reason: unknown;
  let started = false;
  let terminal = false;
  let finished = false;
  let json = '';
  let poison: Contracts.Failure | undefined;

  const readSse = createSseReader('anthropic', (data, names) => {
    const value: unknown = JSON.parse(data);
    if (
      !isJsonObject(value) ||
      typeof value.type !== 'string' ||
      names.length > 1 ||
      (names[0] && names[0] !== value.type)
    )
      return fail('anthropic.event', 'Invalid streaming event');
    if (value.type === 'ping') return ok([]);
    if (value.type === 'error')
      return fail('anthropic.stream', 'Provider reported a streaming error', 'unavailable');
    if (terminal) return fail('anthropic.trailing', 'Event after message_stop');
    if (value.type === 'message_start') {
      if (
        started ||
        !isJsonObject(value.message) ||
        value.message.role !== 'assistant' ||
        !Array.isArray(value.message.content) ||
        value.message.content.length ||
        !isJsonObject(value.message.usage)
      )
        return fail('anthropic.start', 'Invalid message_start');
      started = true;
      usage = value.message.usage;
      return ok([]);
    }
    if (!started) return fail('anthropic.start', 'Missing message_start');
    if (value.type === 'message_stop') {
      if (blocks.some(({ closed }) => !closed) || typeof reason !== 'string')
        return fail('anthropic.stop', 'Message stopped before its content completed');
      terminal = true;
      return ok([]);
    }
    if (value.type === 'message_delta') {
      if (!isJsonObject(value.delta) || (value.usage !== undefined && !isJsonObject(value.usage)))
        return fail('anthropic.delta', 'Invalid message delta');
      if (value.delta.stop_reason != null) reason = value.delta.stop_reason;
      usage = { ...usage, ...value.usage };
      return ok([]);
    }
    if (!['content_block_start', 'content_block_delta', 'content_block_stop'].includes(value.type))
      return ok([]); // The API can add stream events.
    const index = value.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
      return fail('anthropic.block', 'Invalid content block index');
    if (value.type === 'content_block_start') {
      const block = readBlock(value.content_block);
      if (!block || index !== blocks.length)
        return fail('anthropic.block', 'Unsupported or out-of-order content block', 'unsupported');
      blocks.push({ block, closed: false });
      return ok(block.kind === 'text' ? event(block.text) : []);
    }
    const current = blocks[index];
    if (!current || current.closed) return fail('anthropic.block', 'Content block is not open');
    if (value.type === 'content_block_stop') {
      current.closed = true;
      return ok([]);
    }
    const { block } = current;
    const delta = value.delta;
    if (
      block.kind === 'text' &&
      isJsonObject(delta) &&
      delta.type === 'text_delta' &&
      typeof delta.text === 'string'
    ) {
      block.text += delta.text;
      return ok(event(delta.text));
    }
    if (
      block.kind === 'tool' &&
      isJsonObject(delta) &&
      delta.type === 'input_json_delta' &&
      typeof delta.partial_json === 'string'
    ) {
      block.partial += delta.partial_json;
      return ok([]);
    }
    return fail('anthropic.delta', 'Unsupported content delta', 'unsupported');
  });

  return ok({
    push(chunk) {
      if (poison) return { ok: false, error: poison };
      if (finished) return fail('anthropic.finished', 'Decoder already finished');
      try {
        const text = utf8.decode(chunk, { stream: true });
        if (!streaming) {
          json += text;
          return ok([]);
        }
        const result = readSse(text);
        if (!result.ok) poison = result.error;
        return result;
      } catch {
        const result = fail('anthropic.decode', 'Malformed JSON or UTF-8');
        poison = result.error;
        return result;
      }
    },
    finish() {
      if (poison) return { ok: false, error: poison };
      if (finished) return fail('anthropic.finished', 'Decoder already finished');
      finished = true;
      try {
        const tail = utf8.decode();
        if (streaming) {
          const result = readSse(tail, true);
          if (!result.ok) return result;
          if (!terminal) return fail('anthropic.eof', 'Missing message_stop');
        } else {
          const value: unknown = JSON.parse(json + tail);
          if (
            !isJsonObject(value) ||
            value.type !== 'message' ||
            value.role !== 'assistant' ||
            !Array.isArray(value.content) ||
            !isJsonObject(value.usage)
          )
            return fail('anthropic.response', 'Invalid message envelope');
          reason = value.stop_reason;
          usage = value.usage;
          for (const item of value.content) {
            const block = readBlock(item);
            if (!block) return fail('anthropic.block', 'Unsupported content block', 'unsupported');
            blocks.push({ block, closed: true });
          }
        }
        const content: Model.ContentPart[] = [];
        const toolCalls: Model.ToolCall[] = [];
        const ids = new Set<string>();
        for (const { block } of blocks) {
          if (block.kind === 'text') {
            if (block.text) content.push({ kind: 'text', text: block.text });
            continue;
          }
          const args: unknown = block.partial ? JSON.parse(block.partial) : block.input;
          if (!isJsonObject(args) || ids.has(block.id))
            return fail('anthropic.tool', 'Invalid tool arguments or duplicate tool ID');
          ids.add(block.id);
          toolCalls.push({ id: block.id, toolId: block.name, arguments: args });
        }
        const normalized =
          reason === 'end_turn' || reason === 'stop_sequence'
            ? 'stop'
            : reason === 'max_tokens' || reason === 'model_context_window_exceeded'
              ? 'length'
              : reason === 'refusal'
                ? 'content_filter'
                : reason === 'tool_use'
                  ? 'tool_calls'
                  : undefined;
        if (
          !normalized ||
          typeof reason !== 'string' ||
          (normalized === 'tool_calls') !== !!toolCalls.length
        )
          return fail(
            'anthropic.finish',
            'Unsupported stop reason or incomplete tool calls',
            'unsupported',
          );
        const { input_tokens: input, output_tokens: output } = usage;
        if (
          typeof input !== 'number' ||
          !Number.isSafeInteger(input) ||
          input < 0 ||
          typeof output !== 'number' ||
          !Number.isSafeInteger(output) ||
          output < 0
        )
          return fail('anthropic.usage', 'Invalid token usage');
        return ok({
          content,
          toolCalls,
          finish: { normalized, native: reason },
          usage: { inputTokens: input, outputTokens: output, providerNative: usage },
        });
      } catch {
        return fail('anthropic.decode', 'Malformed JSON, tool arguments or UTF-8');
      }
    },
  });
}
