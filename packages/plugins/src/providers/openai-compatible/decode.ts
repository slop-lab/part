import { fail, isJson, isJsonObject, ok } from '@part/core/contracts';
import type { Contracts, Model, Runtime } from '@part/core/reference';

export function createChatDecoder(response: {
  status?: number;
  headers: Readonly<Record<string, string>>;
}): Contracts.Result<Model.ResponseDecoder> {
  if (response.status !== undefined && (response.status < 200 || response.status >= 300))
    return fail(
      'openai-compatible.http',
      `Provider returned HTTP ${response.status}`,
      'unavailable',
    );
  const media =
    Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ??
    'text/event-stream';
  if (!media.includes('text/event-stream') && !media.includes('application/json'))
    return fail('openai-compatible.media', 'Expected JSON or SSE', 'unsupported');
  const streaming = media.includes('text/event-stream'),
    utf8 = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    text = '',
    finish: string | undefined,
    done = false,
    poison: Contracts.Failure | undefined,
    usage: Runtime.Usage = {};
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  function consumeValue(value: unknown): Contracts.Result<readonly Model.ProviderEvent[]> {
    if (!isJsonObject(value) || value.error || !Array.isArray(value.choices))
      return fail('openai-compatible.response', 'Invalid completion envelope');
    if (value.usage !== undefined && value.usage !== null) {
      if (
        !isJsonObject(value.usage) ||
        ['prompt_tokens', 'completion_tokens', 'total_tokens'].some(
          (key) =>
            value.usage &&
            (!Number.isSafeInteger((value.usage as Record<string, unknown>)[key]) ||
              Number((value.usage as Record<string, unknown>)[key]) < 0),
        )
      )
        return fail('openai-compatible.usage', 'Invalid usage');
      usage = {
        inputTokens: Number(value.usage.prompt_tokens),
        outputTokens: Number(value.usage.completion_tokens),
        providerNative: value.usage,
      };
    }
    if (!value.choices.length)
      return finish ? ok([]) : fail('openai-compatible.choice', 'Missing completion choice');
    if (value.choices.length !== 1)
      return fail('openai-compatible.choice', 'Only one choice is supported', 'unsupported');
    const choice = value.choices[0];
    if (!isJsonObject(choice) || choice.index !== 0 || finish)
      return fail('openai-compatible.choice', 'Duplicate or invalid completion choice');
    const delta = streaming ? choice.delta : choice.message;
    if (!isJsonObject(delta)) return fail('openai-compatible.delta', 'Missing message/delta');
    if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string')
      return fail('openai-compatible.content', 'Only text output is supported', 'unsupported');
    if (
      (delta.refusal !== undefined && delta.refusal !== null) ||
      (delta.audio !== undefined && delta.audio !== null) ||
      delta.function_call !== undefined
    )
      return fail(
        'openai-compatible.content',
        'Unsupported required output content',
        'unsupported',
      );
    const events: Model.ProviderEvent[] = [];
    if (typeof delta.content === 'string') {
      text += delta.content;
      events.push({ type: 'text-delta', payload: { text: delta.content } });
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls))
        return fail('openai-compatible.tools', 'Invalid tool calls');
      for (let offset = 0; offset < delta.tool_calls.length; offset++) {
        const call = delta.tool_calls[offset];
        if (
          !isJsonObject(call) ||
          (call.type !== undefined && call.type !== 'function') ||
          !isJsonObject(call.function)
        )
          return fail(
            'openai-compatible.tools',
            'Only function tool calls are supported',
            'unsupported',
          );
        const index = streaming ? call.index : offset;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > 1024)
          return fail('openai-compatible.tools', 'Invalid tool call index');
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (call.id !== undefined) {
          if (typeof call.id !== 'string' || (current.id && current.id !== call.id))
            return fail('openai-compatible.tools', 'Tool call ID changed');
          current.id = call.id;
        }
        for (const key of ['name', 'arguments'] as const)
          if (call.function[key] !== undefined) {
            if (typeof call.function[key] !== 'string')
              return fail('openai-compatible.tools', 'Invalid tool function fragment');
            current[key] += call.function[key];
          }
        calls.set(index, current);
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (
        !['stop', 'tool_calls', 'length', 'content_filter'].includes(String(choice.finish_reason))
      )
        return fail('openai-compatible.finish', 'Unsupported finish reason', 'unsupported');
      finish = String(choice.finish_reason);
    }
    return ok(events);
  }
  function consumeFrames(flush = false): Contracts.Result<readonly Model.ProviderEvent[]> {
    const events: Model.ProviderEvent[] = [];
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (done) return fail('openai-compatible.trailing', 'Data after stream end');
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return fail('openai-compatible.json', 'Malformed stream JSON');
      }
      const decoded = consumeValue(parsed);
      if (!decoded.ok) return decoded;
      events.push(...decoded.value);
    }
    if (flush && buffer.trim()) return fail('openai-compatible.frame', 'Incomplete SSE frame');
    return ok(events);
  }
  return ok({
    push(chunk) {
      if (poison) return { ok: false, error: poison };
      try {
        buffer += utf8.decode(chunk, { stream: true });
        buffer = buffer.replaceAll('\r\n', '\n');
        const result = streaming ? consumeFrames() : ok([]);
        if (!result.ok) poison = result.error;
        return result;
      } catch {
        const result = fail('openai-compatible.utf8', 'Invalid UTF-8');
        poison = result.error;
        return result;
      }
    },
    finish() {
      if (poison) return { ok: false, error: poison };
      try {
        buffer += utf8.decode();
        const consumed = streaming ? consumeFrames(true) : consumeValue(JSON.parse(buffer));
        if (!consumed.ok) return consumed;
        if (!finish || (streaming && !done))
          return fail('openai-compatible.eof', 'Missing terminal completion or [DONE]');
        const toolCalls: Model.ToolCall[] = [],
          ids = new Set<string>();
        for (const call of calls.values()) {
          if (!call.id || !call.name || ids.has(call.id))
            return fail('openai-compatible.tools', 'Incomplete or duplicate tool call');
          ids.add(call.id);
          const args: unknown = JSON.parse(call.arguments);
          if (!isJson(args)) return fail('openai-compatible.arguments', 'Invalid tool arguments');
          toolCalls.push({ id: call.id, toolId: call.name, arguments: args });
        }
        if ((finish === 'tool_calls') !== !!toolCalls.length)
          return fail('openai-compatible.finish', 'Tool calls and finish reason disagree');
        return ok({
          content: text ? [{ kind: 'text', text }] : [],
          toolCalls,
          finish: { normalized: finish, native: finish },
          usage,
        });
      } catch {
        return fail('openai-compatible.decode', 'Malformed JSON, tool arguments or UTF-8');
      }
    },
  });
}
