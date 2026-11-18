// @ts-check
import { parseObject } from '../fixtures/contracts.mjs';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { expectProperty, present, stub } from '../fixtures/assertions.mjs';

test('JSON and SSE replies support function calls and Unicode; malformed or truncated streams fail closed', async () => {
  const adapter = createOpenAICompatibleAdapter();
  /** @param {import("@slop-lab/part/reference/index.js").Contracts.Json} delta @param {string | null} finish_reason */
  const event = (delta, finish_reason = null) => ({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'part-mock',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const data = [
    event({ content: 'snowman ☃' }),
    event({
      tool_calls: [
        {
          index: 0,
          id: 'call',
          type: 'function',
          function: { name: 'uppercase', arguments: '{"text":' },
        },
      ],
    }),
    event({ tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] }, 'tool_calls'),
  ];
  const wire =
    data.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
  const decoder = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  for (const byte of new TextEncoder().encode(wire))
    assert.equal(decoder.push(Uint8Array.of(byte)).ok, true);
  const result = decoder.finish();
  assert.equal(result.ok, true);
  assert.equal(expectProperty(result.value.content[0], 'text'), 'snowman ☃');
  assert.deepEqual(present(result.value.toolCalls[0]).arguments, { text: 'hello' });
  const partial = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  partial.push(new TextEncoder().encode(wire.replace('data: [DONE]\r\n\r\n', '')));
  assert.equal(partial.finish().ok, false);
  const invalid = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'text/event-stream' } }),
    'value',
  );
  assert.equal(invalid.push(new TextEncoder().encode('data: {broken}\n\n')).ok, false);
  assert.equal(invalid.finish().ok, false);
  const json = expectProperty(
    adapter.createDecoder({ headers: { 'content-type': 'application/json' } }),
    'value',
  );
  json.push(
    new TextEncoder().encode(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: 'assistant', content: 'json' }, finish_reason: 'stop' },
        ],
      }),
    ),
  );
  assert.equal(expectProperty(expectProperty(json.finish(), 'value').content[0], 'text'), 'json');
  assert.equal(adapter.createDecoder({ status: 429, headers: {} }).ok, false);
});

test('Non-streaming OpenAI requests omit stream-only options while SSE requests request usage', async () => {
  const adapter = createOpenAICompatibleAdapter();
  for (const stream of [false, true]) {
    const encoded = await adapter.encode(
      { profileId: 'fixture', context: stub({ fragments: [] }), tools: [], options: {} },
      stub({ model: 'part-mock', defaults: { stream } }),
    );
    assert.equal(encoded.ok, true);
    const body = parseObject(new TextDecoder().decode(encoded.value.body));
    assert.equal(body.stream, stream);
    assert.deepEqual(body.stream_options, stream ? { include_usage: true } : undefined);
  }
});

test('OpenAI JSON and SSE accept null tool_calls without accepting malformed non-null calls', () => {
  const adapter = createOpenAICompatibleAdapter();
  for (const streaming of [false, true]) {
    for (const toolCalls of [null, { invalid: true }]) {
      const decoder = expectProperty(
        adapter.createDecoder({
          status: 200,
          headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
        }),
        'value',
      );
      const completion = {
        choices: [
          {
            index: 0,
            [streaming ? 'delta' : 'message']: {
              role: 'assistant',
              content: 'HELLO',
              tool_calls: toolCalls,
            },
            finish_reason: 'stop',
          },
        ],
      };
      const pushed = decoder.push(
        new TextEncoder().encode(
          streaming
            ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`
            : JSON.stringify(completion),
        ),
      );
      const decoded = decoder.finish();
      if (toolCalls === null) {
        assert.equal(pushed.ok, true);
        assert.equal(decoded.ok, true);
        assert.deepEqual(decoded.value.toolCalls, []);
        assert.deepEqual(decoded.value.content, [{ kind: 'text', text: 'HELLO' }]);
      } else {
        assert.equal(decoded.ok, false);
        assert.equal(decoded.error.code, 'part.openai-compatible.tools');
      }
    }
  }
});
