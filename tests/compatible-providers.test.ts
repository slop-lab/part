import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createChatGPTModel, createProviderModel } from '@slop-lab/part-plugins/providers/index.js';
import { isJsonObject, schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import { stub } from '../fixtures/assertions.mjs';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';

function messagesStream(events: Record<string, unknown>[]) {
  const wire = new TextEncoder().encode(
    events
      .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
      .join(''),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of wire) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('Anthropic Messages uses common model and transport configuration through a complete tool turn', async () => {
  let calls = 0;
  const model = createProviderModel({
    protocol: 'messages',
    model: 'fast',
    modelMap: { fast: 'anthropic-test' },
    baseURL: 'https://gateway.invalid/api/messages/',
    apiKey: () => `key-${calls}`,
    headers: { 'x-project': 'fixture' },
    defaults: { max_tokens: 256 },
    async fetch(url, init) {
      assert.equal(String(url), 'https://gateway.invalid/api/messages');
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('x-api-key'), `key-${calls}`);
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      assert.equal(headers.get('x-project'), 'fixture');
      const body = await new Response(init?.body).json();
      assert.equal(body.model, 'anthropic-test');
      assert.equal(body.max_tokens, 256);
      assert.deepEqual(body.tools[0].input_schema, { type: 'object' });
      calls++;
      if (calls === 1)
        return messagesStream([
          {
            type: 'message_start',
            message: {
              role: 'assistant',
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_test', name: 'echo', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"text":' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '"한글"}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ]);
      assert.deepEqual(body.messages.slice(-2), [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_test', name: 'echo', input: { text: '한글' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_test', content: JSON.stringify('echoed') },
          ],
        },
      ]);
      return Response.json({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '완료' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    },
  });
  // The runtime tool accepts the projected input schema independently of provider advertising.
  const agent = createAgent({
    model,
    tools: [
      functionTool({
        id: 'echo',
        input: schema('test/args', isJsonObject),
        output: stringSchema,
        execute(input) {
          assert.deepEqual(input, { text: '한글' });
          return 'echoed';
        },
      }),
    ],
    toolSchemas: { echo: { type: 'object' } },
  });
  assert.ok(agent.ok);
  try {
    const outcome = await agent.value.generate('Run echo');
    assert.ok(outcome.ok);
    assert.equal(outcome.value.phase, 'completed', JSON.stringify(outcome.value));
    assert.deepEqual(outcome.value.result.content, [{ kind: 'text', text: '완료' }]);
    assert.equal(outcome.value.result.usage.outputTokens, 3);
    assert.equal(calls, 2);
  } finally {
    await agent.value.dispose();
  }
});

test('ChatGPT profile encodes requests for the public plan route and retains structured HTTP errors', async () => {
  const model = createChatGPTModel({ model: 'fixture', accessToken: 'inert' });
  assert.equal(model.profile.endpoint, 'https://api.openai.com/v1/responses');
  const invocation: Model.Invocation = {
    profileId: model.profile.id,
    context: stub({
      fragments: [
        stub({
          kind: 'message',
          role: 'system',
          content: [{ kind: 'text', text: 'Host instructions' }],
        }),
      ],
    }),
    tools: [
      {
        id: 'echo',
        description: 'Echo',
        execution: 'runtime',
        version: '1',
        inputSchema: { type: 'object' },
      },
    ],
    options: {},
  };
  const encoded = await model.adapter.encode(invocation, model.profile);
  assert.ok(encoded.ok);
  const body = JSON.parse(new TextDecoder().decode(encoded.value.body));
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.input, [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'function',
          name: 'echo',
          description: 'Echo',
          parameters: { type: 'object' },
          strict: false,
        },
      ],
    },
    { role: 'developer', content: 'Host instructions' },
  ]);
  const invalidPlanOptions: Contracts.Json[] = [{ stream: false }, { max_output_tokens: 10 }];
  for (const options of invalidPlanOptions)
    assert.equal((await model.adapter.encode({ ...invocation, options }, model.profile)).ok, false);

  const denied = model.adapter.createDecoder({
    status: 429,
    headers: { 'X-Request-Id': 'req_123' },
  });
  assert.ok(denied.ok);
  assert.ok(
    denied.value.push(
      new TextEncoder().encode(
        JSON.stringify({
          error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'upstream prose' },
        }),
      ),
    ).ok,
  );
  const error = denied.value.finish();
  assert.ok(!error.ok);
  assert.deepEqual(error.error.details, {
    status: 429,
    requestId: 'req_123',
    code: 'subscription_sharing_usage_limit_exceeded',
  });
});
