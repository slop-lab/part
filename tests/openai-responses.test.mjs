// @ts-check
import { parseObject } from '../fixtures/contracts.mjs';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import { digest } from '@slop-lab/part/contracts/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, present, stub } from '../fixtures/assertions.mjs';
import {
  adapter,
  profile,
  message,
  call,
  reasoning,
  completion,
  event,
  wire,
  eventsFor,
} from '../fixtures/openai-responses.mjs';

/** @import {Context, Model, Contracts} from '@slop-lab/part/reference/index.js' */

/** @param {Context.Fragment[]} fragments @param {Contracts.Json} options @returns {Model.Invocation} */
const invocation = (fragments = [], options = {}) => ({
  profileId: profile.id,
  context: stub({ fragments }),
  tools: [],
  options,
});
/** @param {Context.Fragment["role"]} role @param {Context.Fragment["content"]} content @param {Context.Fragment["kind"]} kind @param {Context.Fragment["toolRelation"]} [toolRelation] @returns {Context.Fragment} */
const fragment = (role, content, kind = 'message', toolRelation) =>
  stub({
    role,
    content,
    kind,
    ...(toolRelation ? { toolRelation } : {}),
  });
/** @param {string} text @returns {Model.ContentPart} */
const textPart = (text) => ({ kind: 'text', text });

/** @param {unknown} value @param {boolean} streaming @param {boolean} bytes */
function decode(value, streaming = false, bytes = false) {
  const decoder = expectProperty(
    adapter.createDecoder({
      status: 200,
      headers: {
        'Content-Type': streaming ? 'text/event-stream; charset=utf-8' : 'application/json',
      },
    }),
    'value',
  );
  const body = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  let progress = [];
  for (const chunk of bytes ? [...body].map((byte) => Uint8Array.of(byte)) : [body]) {
    const pushed = decoder.push(chunk);
    if (pushed.ok === false) return pushed;
    progress.push(...pushed.value);
  }
  const result = decoder.finish();
  return result.ok === true ? { ...result, progress } : result;
}

test('Responses encodes text, JSON, function calls/results and native reasoning without hidden state', async () => {
  let source = invocation(
    [
      fragment('system', [textPart('System')]),
      fragment('user', [{ kind: 'json', value: { task: 'hello' } }]),
      fragment('assistant', [
        {
          kind: 'native',
          native: { provider: adapter.id, formatVersion: '1', payload: reasoning },
        },
      ]),
      fragment('assistant', [{ kind: 'json', value: { text: 'hello' } }], 'tool-call', {
        callId: 'call-1',
        toolId: 'uppercase',
      }),
      fragment('tool', [], 'tool-result', { callId: 'call-1', toolId: 'uppercase' }),
    ],
    { stream: false, max_output_tokens: 50 },
  );
  source = {
    ...source,
    tools: [
      {
        id: 'uppercase',
        description: 'Uppercase',
        execution: 'runtime',
        version: '1',
        inputSchema: { type: 'object' },
      },
    ],
  };
  const encoded = await adapter.encode(source, profile);
  assert.equal(encoded.ok, true);
  assert.equal(encoded.value.protocol, 'openai.responses');
  assert.equal(encoded.value.digest, await digest(encoded.value.body));
  const body = parseObject(new TextDecoder().decode(encoded.value.body));
  assert.deepEqual(body.input, [
    { role: 'system', content: 'System' },
    { role: 'user', content: '{"task":"hello"}' },
    reasoning,
    { type: 'function_call', call_id: 'call-1', name: 'uppercase', arguments: '{"text":"hello"}' },
    { type: 'function_call_output', call_id: 'call-1', output: '' },
  ]);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.max_output_tokens, 50);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.tools, [
    {
      type: 'function',
      name: 'uppercase',
      description: 'Uppercase',
      parameters: { type: 'object' },
      strict: false,
    },
  ]);
});

test('Responses rejects reserved/stateful requests, hosted tools, media and foreign native content before delivery', async () => {
  /** @type {Contracts.Json[]} */
  const forbiddenOptions = [
    { input: [] },
    { model: 'override' },
    { tools: [] },
    { messages: [] },
    { store: true },
    { background: true },
    { previous_response_id: null },
    { conversation: 'c' },
    { prompt: {} },
    { stream: 'yes' },
    { stream_options: {} },
    { max_completion_tokens: 1 },
  ];
  for (const options of forbiddenOptions)
    assert.equal((await adapter.encode(invocation([], options), profile)).ok, false);
  assert.equal(
    (
      await adapter.encode(
        {
          ...invocation(),
          continuation: { provider: adapter.id, formatVersion: '1', payload: 'token' },
        },
        profile,
      )
    ).ok,
    false,
  );
  assert.equal(
    (await adapter.encode({ ...invocation(), tools: [stub({ execution: 'provider' })] }, profile))
      .ok,
    false,
  );
  /** @type {Partial<Model.ContentPart>[]} */
  const invalidParts = [
    { kind: 'media' },
    {
      kind: 'native',
      native: { provider: 'other/provider', formatVersion: '1', payload: reasoning },
    },
    { kind: 'native', native: { provider: adapter.id, formatVersion: '2', payload: reasoning } },
  ];
  for (const part of invalidParts)
    assert.equal(
      (await adapter.encode(invocation([fragment('assistant', [stub(part)])]), profile)).ok,
      false,
    );
  assert.equal(
    (
      await createOpenAICompatibleAdapter().encode(
        invocation([
          fragment('assistant', [
            {
              kind: 'native',
              native: { provider: adapter.id, formatVersion: '1', payload: reasoning },
            },
          ]),
        ]),
        profile,
      )
    ).ok,
    false,
  );
});

test('JSON Responses preserves reasoning and function native items, call IDs, usage and finish', () => {
  const result = decode(completion([reasoning, call, message('HELLO')]));
  assert.equal(result.ok, true);
  assert.equal(expectProperty(result.value, 'finish').normalized, 'tool_calls');
  assert.deepEqual(
    expectProperty(expectProperty(result.value, 'content')[0], 'native').payload,
    reasoning,
  );
  assert.equal(present(expectProperty(result.value, 'toolCalls')[0]).id, 'call-1');
  assert.deepEqual(present(expectProperty(result.value, 'toolCalls')[0]).arguments, {
    text: 'hello',
  });
  assert.deepEqual(
    present(present(expectProperty(result.value, 'toolCalls')[0]).native).payload,
    call,
  );
  assert.deepEqual(expectProperty(result.value, 'usage'), {
    inputTokens: 12,
    outputTokens: 3,
    providerNative: completion().usage,
  });
});

test('SSE Responses handles every UTF-8/CRLF boundary, fragmented arguments and multiple output indices without duplicate text', () => {
  const output = [
    reasoning,
    message('Snowman ☃'),
    call,
    { ...call, id: 'fc-2', call_id: 'call-2' },
  ];
  for (const newline of ['\n', '\r\n', '\r']) {
    const result = decode(wire(eventsFor(output), newline), true, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(
      expectProperty(result, 'progress')
        .filter((entry) => entry.type === 'text-delta')
        .map((entry) => expectProperty(entry.payload, 'text'))
        .join(''),
      'Snowman ☃',
    );
    assert.equal(
      expectProperty(result.value, 'content')
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join(''),
      'Snowman ☃',
    );
    assert.deepEqual(
      expectProperty(result.value, 'toolCalls').map((entry) => entry.id),
      ['call-1', 'call-2'],
    );
  }
  const finalOnly = wire([event('response.completed', { response: completion() })]);
  assert.equal(decode(finalOnly + 'data: [DONE]\n\n', true).ok, true);
  assert.equal(decode(finalOnly, true).ok, true);
});

test('Responses fails closed on partial tools, invalid usage, unsupported content and duplicate identities', () => {
  const invalid = [
    { ...completion(), status: 'incomplete' },
    { ...completion(), status: 'failed' },
    { ...completion(), usage: { input_tokens: -1, output_tokens: 3, total_tokens: 2 } },
    { ...completion(), usage: { input_tokens: 1, output_tokens: '3', total_tokens: 4 } },
    completion([{ ...call, arguments: '{' }]),
    completion([{ ...call, arguments: '[]' }]),
    completion([{ ...call, status: 'in_progress' }]),
    completion([call, { ...call, id: 'different' }]),
    completion([message('x'), message('y')]),
    completion([{ ...reasoning, summary: [{ type: 'summary_text', text: 42 }] }]),
    completion([{ id: 'web', type: 'web_search_call', status: 'completed' }]),
    completion([{ ...message('x'), content: [{ type: 'refusal', refusal: 'No' }] }]),
    completion([
      {
        ...message('x'),
        content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation' }] }],
      },
    ]),
  ];
  for (const response of invalid)
    assert.equal(decode(response).ok, false, JSON.stringify(response));
  assert.equal(adapter.createDecoder({ status: 429, headers: {} }).ok, false);
  assert.equal(adapter.createDecoder({ headers: { 'content-type': 'text/html' } }).ok, false);
});

test('SSE Responses rejects missing terminals, mismatched snapshots, failed events, malformed framing and poisoned decoders', () => {
  const good = eventsFor([call]);
  /** @type {Record<string, unknown>[][]} */
  const badSequences = [
    good.slice(0, -1),
    [
      ...good.slice(0, -1),
      event('response.failed', { response: { id: 'resp-1', status: 'failed' } }),
    ],
    [
      ...good.slice(0, -1),
      event('response.incomplete', { response: { id: 'resp-1', status: 'incomplete' } }),
    ],
    [...good, event('error', { message: 'late failure' })],
    [event('error', { message: 'provider failure' })],
    [event('response.completed', { response: completion([{ ...call, arguments: '{' }]) })],
    good.map((entry, index) =>
      index === good.length - 1
        ? { ...entry, response: completion([{ ...call, arguments: '{"text":"changed"}' }]) }
        : entry,
    ),
    good.map((entry, index) =>
      index === good.length - 1
        ? { ...entry, response: { ...completion([call]), id: 'changed' } }
        : entry,
    ),
    good.map((entry, index) => (index === 2 ? { ...entry, item_id: 'unknown' } : entry)),
    good.map((entry, index) => (index === 2 ? { ...entry, sequence_number: 0 } : entry)),
    [...good.slice(0, -1), ...good.slice(1)],
  ];
  const textEvents = eventsFor([message('HELLO')]);
  const textDone = textEvents.findIndex((entry) => entry.type === 'response.output_text.done');
  badSequences.push(
    textEvents.map((entry, index) =>
      index === textEvents.length - 1
        ? { ...entry, response: completion([message('DIFFERENT')]) }
        : entry,
    ),
    [
      ...textEvents.slice(0, textDone + 1),
      { ...textEvents[2], sequence_number: undefined },
      ...textEvents.slice(textDone + 1).map((entry) => ({ ...entry, sequence_number: undefined })),
    ],
    good.map((entry, index) =>
      index === good.length - 1
        ? { ...entry, response: completion([{ ...call, name: 'changed' }]) }
        : entry,
    ),
    [
      present(good[0]),
      present(good[1]),
      event('response.completed', { response: completion([{ ...call, call_id: 'changed' }]) }),
    ],
    [
      present(good[0]),
      present(good[1]),
      event('response.completed', { response: completion([{ ...call, name: 'changed' }]) }),
    ],
  );
  for (const events of badSequences) assert.equal(decode(wire(events), true).ok, false);
  for (const malformed of [
    'data: {broken}\n\n',
    wire(good).trimEnd(),
    'data: [DONE]\n\n',
    'event: wrong\ndata: {"type":"response.completed"}\n\n',
  ])
    assert.equal(decode(malformed, true).ok, false);
  const decoder = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  assert.equal(decoder.push(new TextEncoder().encode('data: {broken}\n\n')).ok, false);
  assert.equal(decoder.push(new TextEncoder().encode(wire(good))).ok, false);
  assert.equal(decoder.finish().ok, false);
  const utf8 = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  assert.equal(utf8.push(Uint8Array.of(0xff)).ok, false);
  assert.equal(utf8.finish().ok, false);
});

test('Responses SSE accepts auxiliary events, compatible framing and annotations while validating completed output', () => {
  const annotation = {
    type: 'url_citation',
    start_index: 0,
    end_index: 5,
    title: 'Example',
    url: 'https://example.test',
  };
  const output = message('HELLO');
  output.content[0].annotations = [annotation];
  const events = [
    event('response.created', { response: { id: 'resp-1', status: 'queued' } }),
    event('response.queued', { response: { id: 'resp-1', status: 'queued' } }),
    event('response.in_progress', { response: { id: 'resp-1', status: 'in_progress' } }),
    event('response.output_item.added', {
      output_index: 0,
      item: { ...output, status: 'in_progress' },
    }),
  ];
  const frames =
    'event: ping\ndata: [PING]\n\n' +
    wire([event('codex.rate_limits', {}), event('codex.response.metadata', {})]) +
    wire(events) +
    'event: message\ndata: {"type":"response.provider.metadata"}\n\n' +
    'event: response.output_text.delta\ndata: {"item_id":"msg-1","content_index":0,"delta":"HELLO"}\n\n' +
    wire([
      event('response.output_text.annotation.added', {
        output_index: 0,
        content_index: 0,
        annotation,
      }),
      event('response.output_item.done', { output_index: 0, item: output }),
      event('response.completed', { response: completion([output]) }),
      event('response.provider.metrics', {}),
    ]);
  const result = decode(frames, true, true);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value.content, [{ kind: 'text', text: 'HELLO' }]);
  assert.deepEqual(result.progress, [{ type: 'text-delta', payload: { text: 'HELLO' } }]);

  const malformed = decode(wire([event('response.output_text.delta', { delta: 'lost' })]), true);
  assert.ok(!malformed.ok);
  assert.equal(expectProperty(malformed.error.details, 'eventType'), 'response.output_text.delta');
  assert.equal(
    decode('event: ping\ndata: {"type":"response.failed"}\n\n' + frames, true).ok,
    false,
  );
});
