import { parseObject } from '../fixtures/contracts.mjs';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { createFetchTransport, noAuth } from '@slop-lab/part/model/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { expectProperty, present } from '../fixtures/assertions.mjs';
import { adapter, profile, completion, wire, eventsFor } from '../fixtures/openai-responses.mjs';

import type { Contracts } from '@slop-lab/part/reference/index.js';
import type { OutputItem } from '../fixtures/openai-responses.mjs';

for (const mode of ['json', 'sse', 'truncated']) {
  test(`Responses fixed ${mode} fixture validates reasoning replay and prevents partial tool execution`, async () => {
    const fixture: {
      prompt: string;
      exchanges: {
        request: Record<string, Contracts.Json> & {
          tools: [{ parameters: Contracts.Json }];
          stream: boolean;
        };
        response: ReturnType<typeof completion> & { output: OutputItem[] };
      }[];
    } = JSON.parse(
      await readFile(
        new URL('../fixtures/openai-responses/tool-flow.fixture.json', import.meta.url),
        'utf8',
      ),
    );
    if (mode === 'json') for (const exchange of fixture.exchanges) exchange.request.stream = false;
    const transcript: { request: unknown; response: unknown }[] = [];
    const executions: string[] = [];
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
          assert.ok(init?.body instanceof Uint8Array);
          const request = parseObject(new TextDecoder().decode(init.body));
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
            (value: unknown): value is { text: string } =>
              value !== null &&
              typeof value === 'object' &&
              'text' in value &&
              typeof value.text === 'string',
          ),
          output: stringSchema,
          execute: ({ text }) => {
            executions.push(text);
            return text.toUpperCase();
          },
        }),
      ],
      toolSchemas: { uppercase: present(fixture.exchanges[0]).request.tools[0].parameters },
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
      assert.equal(expectProperty(outcome.value.result.content[0], 'text'), 'HELLO');
      assert.equal(transcript.length, 2);
      assert.deepEqual(transcript, fixture.exchanges);
    } finally {
      await created.value.dispose();
    }
  });
}
