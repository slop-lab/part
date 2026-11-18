import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model, Runtime } from '@slop-lab/part/reference/index.js';

export function isReasoningItem(value: unknown): value is Record<string, Contracts.Json> {
  return (
    isJsonObject(value) &&
    value.type === 'reasoning' &&
    (value.status === undefined || value.status === null || value.status === 'completed') &&
    typeof value.id === 'string' &&
    !!value.id &&
    Array.isArray(value.summary) &&
    value.summary.every(
      (part) => isJsonObject(part) && part.type === 'summary_text' && typeof part.text === 'string',
    ) &&
    (value.encrypted_content === undefined ||
      value.encrypted_content === null ||
      typeof value.encrypted_content === 'string') &&
    (value.content === undefined ||
      value.content === null ||
      (Array.isArray(value.content) &&
        value.content.every(
          (part) =>
            isJsonObject(part) && part.type === 'reasoning_text' && typeof part.text === 'string',
        )))
  );
}

function isTextAnnotation(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  const offset = (index: unknown) =>
    typeof index === 'number' && Number.isSafeInteger(index) && index >= 0;
  if (value.type === 'file_path' || value.type === 'file_citation')
    return (
      typeof value.file_id === 'string' &&
      offset(value.index) &&
      (value.type === 'file_path' || typeof value.filename === 'string')
    );
  if (
    !offset(value.start_index) ||
    !offset(value.end_index) ||
    Number(value.start_index) > Number(value.end_index)
  )
    return false;
  if (value.type === 'url_citation')
    return typeof value.url === 'string' && typeof value.title === 'string';
  return (
    value.type === 'container_file_citation' &&
    typeof value.container_id === 'string' &&
    typeof value.file_id === 'string' &&
    typeof value.filename === 'string'
  );
}

export function decodeOutput(value: unknown): Contracts.Result<Model.Response> {
  if (
    !isJsonObject(value) ||
    value.object !== 'response' ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.status !== 'completed' ||
    value.error ||
    value.incomplete_details ||
    !Array.isArray(value.output)
  )
    return fail(
      'openai-responses.response',
      'Expected a completed response without error or incomplete details',
    );
  const content: Model.ContentPart[] = [],
    toolCalls: Model.ToolCall[] = [],
    ids = new Set<string>(),
    callIds = new Set<string>();
  for (const item of value.output) {
    if (!isJsonObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id))
      return fail('openai-responses.item', 'Missing or duplicate output item ID');
    ids.add(item.id);
    if (item.type === 'message') {
      if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content))
        return fail('openai-responses.message', 'Invalid assistant output message');
      for (const part of item.content) {
        if (
          !isJsonObject(part) ||
          part.type !== 'output_text' ||
          typeof part.text !== 'string' ||
          (part.annotations != null &&
            (!Array.isArray(part.annotations) || !part.annotations.every(isTextAnnotation))) ||
          (part.logprobs != null && !Array.isArray(part.logprobs))
        )
          return fail(
            'openai-responses.content',
            'Invalid or unsupported output text',
            'unsupported',
          );
        content.push({ kind: 'text', text: part.text });
      }
    } else if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        callIds.has(item.call_id) ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.arguments !== 'string' ||
        (item.status !== undefined && item.status !== 'completed')
      )
        return fail('openai-responses.tool', 'Invalid or duplicate completed function call');
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        return fail('openai-responses.arguments', 'Malformed function arguments');
      }
      if (!isJsonObject(args))
        return fail('openai-responses.arguments', 'Function arguments must be a JSON object');
      callIds.add(item.call_id);
      toolCalls.push({
        id: item.call_id,
        toolId: item.name,
        arguments: args,
        native: { provider: 'part/openai-responses', formatVersion: '1', payload: item },
      });
    } else if (isReasoningItem(item)) {
      content.push({
        kind: 'native',
        native: { provider: 'part/openai-responses', formatVersion: '1', payload: item },
      });
    } else return fail('openai-responses.item', 'Unsupported output item', 'unsupported');
  }
  let usage: Runtime.Usage = {};
  if (value.usage !== undefined && value.usage !== null) {
    const reported = value.usage;
    if (
      !isJsonObject(reported) ||
      ['input_tokens', 'output_tokens', 'total_tokens'].some(
        (key) => !Number.isSafeInteger(reported[key]) || Number(reported[key]) < 0,
      )
    )
      return fail('openai-responses.usage', 'Invalid token usage');
    usage = {
      inputTokens: Number(reported.input_tokens),
      outputTokens: Number(reported.output_tokens),
      providerNative: reported,
    };
  }
  return ok({
    content,
    toolCalls,
    finish: {
      normalized: toolCalls.length ? 'tool_calls' : 'stop',
      native: { id: value.id, status: value.status },
    },
    usage,
  });
}
