import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible';
import { createAgent } from '@slop-lab/part-plugins/agent';
import { createFetchTransport, noAuth } from '@slop-lab/part/model';
import { functionTool } from '@slop-lab/part/tools';
import { digest, schema, stringSchema } from '@slop-lab/part/contracts';

const adapter = createOpenAIResponsesAdapter();
const profile = {
  id: 'responses',
  revision: '1',
  adapterId: adapter.id,
  transportId: 'part/fetch',
  authStrategyId: 'none',
  model: 'fixture-model',
  endpoint: 'https://fixture.invalid/v1/responses',
  defaults: {},
  capabilities: { revision: '1', entries: [] },
};
const invocation = (fragments = [], options = {}) => ({
  profileId: profile.id,
  context: { fragments },
  tools: [],
  options,
});
const fragment = (role, content, kind = 'message', toolRelation) => ({
  role,
  content,
  kind,
  ...(toolRelation ? { toolRelation } : {}),
});
const textPart = (text) => ({ kind: 'text', text });
const message = (text, id = 'msg-1') => ({
  id,
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const call = {
  id: 'fc-1',
  type: 'function_call',
  status: 'completed',
  call_id: 'call-1',
  name: 'uppercase',
  arguments: '{"text":"hello"}',
};
const reasoning = {
  id: 'rs-1',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Use the tool.' }],
  encrypted_content: 'opaque-fixture',
};
const completion = (output = [message('HELLO')]) => ({
  id: 'resp-1',
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  output,
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    output_tokens_details: { reasoning_tokens: 1 },
  },
});
const event = (type, fields) => ({ type, ...fields });
const wire = (events, newline = '\n') =>
  events
    .map(
      (value) => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`,
    )
    .join('');
function decode(value, streaming = false, bytes = false) {
  const decoder = adapter.createDecoder({
    status: 200,
    headers: {
      'Content-Type': streaming ? 'text/event-stream; charset=utf-8' : 'application/json',
    },
  }).value;
  const body = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  let progress = [];
  for (const chunk of bytes ? [...body].map((byte) => Uint8Array.of(byte)) : [body]) {
    const pushed = decoder.push(chunk);
    if (!pushed.ok) return pushed;
    progress.push(...pushed.value);
  }
  const result = decoder.finish();
  return result.ok ? { ...result, progress } : result;
}
function eventsFor(output) {
  const events = [event('response.created', { response: { id: 'resp-1', status: 'in_progress' } })];
  output.forEach((item, output_index) => {
    events.push(
      event('response.output_item.added', {
        output_index,
        item: {
          ...item,
          status: 'in_progress',
          ...(item.type === 'function_call' ? { arguments: '' } : {}),
        },
      }),
    );
    if (item.type === 'message') {
      const metadata = { output_index, item_id: item.id, content_index: 0 };
      for (const delta of item.content[0].text)
        events.push(event('response.output_text.delta', { ...metadata, delta }));
      events.push(event('response.output_text.done', { ...metadata, text: item.content[0].text }));
    }
    if (item.type === 'function_call') {
      const metadata = { output_index, item_id: item.id };
      for (const delta of item.arguments)
        events.push(event('response.function_call_arguments.delta', { ...metadata, delta }));
      events.push(
        event('response.function_call_arguments.done', { ...metadata, arguments: item.arguments }),
      );
    }
    events.push(event('response.output_item.done', { output_index, item }));
  });
  events.push(event('response.completed', { response: completion(output) }));
  return events.map((entry, sequence_number) => ({ ...entry, sequence_number }));
}

test('Responses encodes text, JSON, function calls/results and native reasoning without hidden state', async () => {
  const source = invocation(
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
  source.tools = [
    {
      id: 'uppercase',
      description: 'Uppercase',
      execution: 'runtime',
      version: '1',
      inputSchema: { type: 'object' },
    },
  ];
  const encoded = await adapter.encode(source, profile);
  assert.equal(encoded.ok, true);
  assert.equal(encoded.value.protocol, 'openai.responses');
  assert.equal(encoded.value.digest, await digest(encoded.value.body));
  const body = JSON.parse(new TextDecoder().decode(encoded.value.body));
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
  for (const options of [
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
  ])
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
    (await adapter.encode({ ...invocation(), tools: [{ execution: 'provider' }] }, profile)).ok,
    false,
  );
  for (const part of [
    { kind: 'media' },
    {
      kind: 'native',
      native: { provider: 'other/provider', formatVersion: '1', payload: reasoning },
    },
    { kind: 'native', native: { provider: adapter.id, formatVersion: '2', payload: reasoning } },
  ])
    assert.equal(
      (await adapter.encode(invocation([fragment('assistant', [part])]), profile)).ok,
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
  assert.equal(result.value.finish.normalized, 'tool_calls');
  assert.deepEqual(result.value.content[0].native.payload, reasoning);
  assert.equal(result.value.toolCalls[0].id, 'call-1');
  assert.deepEqual(result.value.toolCalls[0].arguments, { text: 'hello' });
  assert.deepEqual(result.value.toolCalls[0].native.payload, call);
  assert.deepEqual(result.value.usage, {
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
      result.progress
        .filter((entry) => entry.type === 'text-delta')
        .map((entry) => entry.payload.text)
        .join(''),
      'Snowman ☃',
    );
    assert.equal(
      result.value.content
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join(''),
      'Snowman ☃',
    );
    assert.deepEqual(
      result.value.toolCalls.map((entry) => entry.id),
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
      good[0],
      good[1],
      event('response.completed', { response: completion([{ ...call, call_id: 'changed' }]) }),
    ],
    [
      good[0],
      good[1],
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
  const decoder = adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }).value;
  assert.equal(decoder.push(new TextEncoder().encode('data: {broken}\n\n')).ok, false);
  assert.equal(decoder.push(new TextEncoder().encode(wire(good))).ok, false);
  assert.equal(decoder.finish().ok, false);
  const utf8 = adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }).value;
  assert.equal(utf8.push(Uint8Array.of(0xff)).ok, false);
  assert.equal(utf8.finish().ok, false);
});

for (const mode of ['json', 'sse', 'truncated']) {
  test(`Responses fixed ${mode} fixture validates reasoning replay and prevents partial tool execution`, async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('../fixtures/openai-responses/tool-flow.fixture.json', import.meta.url),
        'utf8',
      ),
    );
    if (mode === 'json') for (const exchange of fixture.exchanges) exchange.request.stream = false;
    const transcript = [],
      executions = [];
    const model = {
      profile: { ...profile, defaults: { stream: mode !== 'json' } },
      adapter,
      auth: noAuth,
      transport: createFetchTransport({
        allowedOrigins: ['https://fixture.invalid'],
        async fetch(url, init) {
          const exchange = fixture.exchanges[transcript.length];
          assert.ok(exchange, 'Unexpected extra request');
          assert.equal(String(url), profile.endpoint);
          const request = JSON.parse(new TextDecoder().decode(init.body));
          assert.deepEqual(request, exchange.request);
          transcript.push({ request, response: exchange.response });
          return new Response(
            mode === 'json'
              ? JSON.stringify(exchange.response)
              : wire(
                  mode === 'truncated'
                    ? eventsFor(exchange.response.output).slice(0, -1)
                    : eventsFor(exchange.response.output),
                ),
            {
              headers: {
                'content-type': mode === 'json' ? 'application/json' : 'text/event-stream',
              },
            },
          );
        },
      }),
    };
    const created = createAgent({
      model,
      limits: { maxModelInvocations: 2, maxToolDispatches: 1 },
      tools: [
        functionTool({
          id: 'uppercase',
          description: 'Uppercase text',
          input: schema(
            'responses/text',
            (value) => value && typeof value === 'object' && typeof value.text === 'string',
          ),
          output: stringSchema,
          execute: ({ text }) => {
            executions.push(text);
            return text.toUpperCase();
          },
        }),
      ],
      toolSchemas: { uppercase: fixture.exchanges[0].request.tools[0].parameters },
    });
    assert.equal(created.ok, true);
    try {
      const outcome = await created.value.generate(fixture.prompt);
      assert.equal(outcome.ok, true);
      if (mode === 'truncated') {
        assert.equal(outcome.value.phase, 'failed');
        assert.equal(outcome.value.error.code, 'part.openai-responses.eof');
        assert.deepEqual(executions, []);
        assert.equal(transcript.length, 1);
        return;
      }
      assert.equal(outcome.value.phase, 'completed', JSON.stringify(outcome));
      assert.deepEqual(executions, ['hello']);
      assert.equal(outcome.value.result.content[0].text, 'HELLO');
      assert.equal(transcript.length, 2);
      assert.deepEqual(transcript, fixture.exchanges);
    } finally {
      await created.value.dispose();
    }
  });
}
