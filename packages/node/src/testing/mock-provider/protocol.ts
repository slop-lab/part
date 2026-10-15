import { isJson, isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { Contracts } from '@slop-lab/part/reference/index.js';
import type { MockChatRequest, MockFixture, MockReply } from './types.js';

export function readChatRequest(value: unknown): MockChatRequest {
  if (
    !isJsonObject(value) ||
    typeof value.model !== 'string' ||
    !value.model ||
    !Array.isArray(value.messages) ||
    !value.messages.length ||
    value.messages.some((message) => !isJsonObject(message) || typeof message.role !== 'string') ||
    (value.stream !== undefined && typeof value.stream !== 'boolean') ||
    (value.n !== undefined && value.n !== 1)
  )
    throw Error('Expected a model, messages and optional stream; only n=1 is supported');
  return structuredClone(value) as MockChatRequest;
}
export function readReply(value: unknown): MockReply {
  if (!isJsonObject(value)) throw Error('Reply must be a JSON object');
  const fields =
    value.kind === 'completion'
      ? ['kind', 'content', 'toolCalls', 'finishReason', 'textChunks', 'usage']
      : value.kind === 'error'
        ? ['kind', 'status', 'message', 'code']
        : ['kind', 'status', 'contentType', 'body'];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw Error('Unknown reply field');
  if (value.kind === 'completion') {
    if (value.content !== null && typeof value.content !== 'string')
      throw Error('Completion content must be string or null');
    if (
      value.finishReason !== undefined &&
      !['stop', 'tool_calls', 'length', 'content_filter'].includes(String(value.finishReason))
    )
      throw Error('Unsupported finish reason');
    if (
      value.toolCalls !== undefined &&
      (!Array.isArray(value.toolCalls) ||
        value.toolCalls.some(
          (call) =>
            !isJsonObject(call) ||
            !call.id ||
            !call.name ||
            typeof call.id !== 'string' ||
            typeof call.name !== 'string' ||
            typeof call.arguments !== 'string',
        ))
    )
      throw Error('Invalid tool calls');
    if (
      Array.isArray(value.toolCalls) &&
      new Set(value.toolCalls.map((call) => (call as { id: string }).id)).size !==
        value.toolCalls.length
    )
      throw Error('Duplicate tool call IDs');
    if (
      value.finishReason !== undefined &&
      (value.finishReason === 'tool_calls') !==
        !!(Array.isArray(value.toolCalls) && value.toolCalls.length)
    )
      throw Error('Tool calls and finish reason disagree');
    if (
      value.textChunks !== undefined &&
      (!Array.isArray(value.textChunks) ||
        value.textChunks.some((text) => typeof text !== 'string') ||
        value.textChunks.join('') !== (value.content ?? ''))
    )
      throw Error('textChunks must concatenate to content');
    if (
      value.usage !== undefined &&
      (!isJsonObject(value.usage) ||
        ['prompt_tokens', 'completion_tokens', 'total_tokens'].some(
          (key) =>
            !Number.isSafeInteger((value.usage as Record<string, unknown>)[key]) ||
            Number((value.usage as Record<string, unknown>)[key]) < 0,
        ))
    )
      throw Error('Invalid usage');
  } else if (value.kind === 'error') {
    if (
      !Number.isInteger(value.status) ||
      Number(value.status) < 400 ||
      Number(value.status) > 599 ||
      typeof value.message !== 'string' ||
      (value.code !== undefined && typeof value.code !== 'string')
    )
      throw Error('Invalid error reply');
  } else if (value.kind === 'raw') {
    if (
      !Number.isInteger(value.status) ||
      Number(value.status) < 200 ||
      Number(value.status) > 599 ||
      typeof value.contentType !== 'string' ||
      /[\r\n]/.test(value.contentType) ||
      typeof value.body !== 'string'
    )
      throw Error('Invalid raw reply');
  } else throw Error('Unknown reply kind');
  return structuredClone(value) as unknown as MockReply;
}
export function readFixture(value: unknown): MockFixture {
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.exchanges)
  )
    throw Error('Invalid fixture envelope');
  const ids = new Set<string>();
  for (const exchange of value.exchanges) {
    if (
      !isJsonObject(exchange) ||
      typeof exchange.id !== 'string' ||
      !exchange.id ||
      ids.has(exchange.id)
    )
      throw Error('Invalid or duplicate exchange ID');
    ids.add(exchange.id);
    readChatRequest(exchange.request);
    readReply(exchange.reply);
  }
  return structuredClone(value) as unknown as MockFixture;
}
export function errorBody(message: string, code = 'mock_error'): Contracts.Json {
  return { error: { message, type: 'mock_provider_error', param: null, code } };
}
export function encodeReply(
  request: MockChatRequest,
  reply: MockReply,
  id: string,
): { status: number; contentType: string; body: string } {
  if (reply.kind === 'raw')
    return { status: reply.status, contentType: reply.contentType, body: reply.body };
  if (reply.kind === 'error')
    return {
      status: reply.status,
      contentType: 'application/json',
      body: JSON.stringify(errorBody(reply.message, reply.code)),
    };
  const calls = reply.toolCalls?.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
  const finish = reply.finishReason ?? (calls?.length ? 'tool_calls' : 'stop');
  const base = { id: `chatcmpl-${id}`, created: 0, model: request.model };
  if (!request.stream)
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...base,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: reply.content,
              ...(calls?.length ? { tool_calls: calls } : {}),
            },
            logprobs: null,
            finish_reason: finish,
          },
        ],
        ...(reply.usage ? { usage: reply.usage } : {}),
      }),
    };
  const events: Contracts.Json[] = [];
  const chunk = (delta: Contracts.Json, finish_reason: string | null = null) =>
    events.push({
      ...base,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
    });
  chunk({ role: 'assistant', content: '' });
  for (const text of reply.textChunks ?? (reply.content === null ? [] : [reply.content]))
    chunk({ content: text });
  calls?.forEach((call, index) => chunk({ tool_calls: [{ index, ...call }] }));
  chunk({}, finish);
  if (
    isJsonObject(request.stream_options) &&
    request.stream_options.include_usage === true &&
    reply.usage
  )
    events.push({
      ...base,
      object: 'chat.completion.chunk',
      choices: [],
      usage: { ...reply.usage },
    });
  if (!isJson(events)) throw Error('Reply is not JSON');
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
  };
}

/** Freeze a fully answered local transcript into exact ordered exchanges. */
export function fixtureFromTranscript(value: unknown, name = 'recorded-mock-flow'): MockFixture {
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.requests) ||
    !value.requests.length ||
    !Array.isArray(value.failures) ||
    value.failures.length ||
    value.remaining !== 0
  )
    throw Error('Only a complete successful transcript can become a fixture');
  return readFixture({
    schemaVersion: 1,
    name,
    exchanges: value.requests.map((record, index) => {
      if (!isJsonObject(record) || record.state !== 'responded' || !record.reply)
        throw Error('Transcript contains unanswered or failed requests');
      return {
        id: `recorded-${index + 1}`,
        request: readChatRequest(record.request),
        reply: readReply(record.reply),
      };
    }),
  });
}
