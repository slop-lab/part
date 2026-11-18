// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { createExampleOpenAIModel } from '../examples/openai-provider.mjs';

// Opt-in only: never run as part of the credential-free test suite.
async function main() {
  const protocol = process.argv[2] ?? 'chat';
  assert.ok(protocol === 'chat' || protocol === 'responses', 'Expected chat or responses protocol');
  const model = process.env.OPENAI_MODEL;
  let requests = 0;
  const cases = [];
  for (const scenario of ['text-json', 'text-sse', 'tool-sse']) {
    const stream = scenario !== 'text-json';
    /** @type {string[]} */
    const toolCalls = [];
    /** @type {{status: number, contentType: string | undefined}[]} */
    const deliveries = [];
    const start = requests;
    /** @type {import("@slop-lab/part/reference/index.js").Contracts.Result<import("@slop-lab/part/reference/index.js").Convenience.Agent<string | readonly import("@slop-lab/part/reference/index.js").Context.SemanticItem[], import("@slop-lab/part/reference/index.js").Model.Response>>} */
    const agent = createAgent({
      limits: {
        maxModelInvocations: scenario === 'tool-sse' ? 2 : 1,
        maxToolDispatches: 1,
        deadline: new Date(Date.now() + 120000).toISOString(),
      },
      model: createExampleOpenAIModel(process.env, {
        protocol,
        id: 'provider-smoke',
        stream,
        maxTokens: 256,
        async fetch(url, init) {
          assert.ok(++requests <= 4, 'Smoke request limit exceeded');
          const response = await fetch(url, init);
          deliveries.push({
            status: response.status,
            contentType: response.headers.get('content-type')?.split(';')[0],
          });
          return response;
        },
      }),
      ...(scenario === 'tool-sse'
        ? {
            tools: [
              functionTool({
                id: 'uppercase',
                description: 'Convert text to uppercase. Use this tool when asked.',
                input: schema(
                  'smoke/text',
                  /** @param {unknown} value @returns {value is {text: string}} */
                  (value) =>
                    value !== null &&
                    typeof value === 'object' &&
                    'text' in value &&
                    value.text === 'hello',
                ),
                output: stringSchema,
                /** @returns {string} */
                execute: ({ text }) => {
                  toolCalls.push(text);
                  return text.toUpperCase();
                },
              }),
            ],
            toolSchemas: {
              uppercase: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          }
        : {}),
    });
    assert.equal(agent.ok, true, 'Agent creation failed');
    try {
      const result = await agent.value.generate(
        scenario === 'tool-sse'
          ? 'Call uppercase exactly once with text "hello". After receiving its result, reply with exactly HELLO. You must use the tool.'
          : 'Reply with exactly HELLO.',
      );
      // Report only structured codes, never upstream error bodies or credentials.
      assert.ok(result.ok, `${scenario}: ${!result.ok ? result.error.code : 'execution failed'}`);
      assert.equal(
        result.value.phase,
        'completed',
        `${scenario}: ${result.value.phase !== 'completed' ? (result.value.error?.code ?? result.value.phase) : 'completed'}; HTTP ${deliveries.map((entry) => entry.status).join(',')}`,
      );
      /** @type {import("@slop-lab/part/reference/index.js").Model.Response} */
      const response = result.value.result;
      const text = response.content
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join('');
      assert.equal(text.trim(), 'HELLO', `${scenario}: unexpected text`);
      assert.deepEqual(toolCalls, scenario === 'tool-sse' ? ['hello'] : []);
      assert.equal(requests - start, scenario === 'tool-sse' ? 2 : 1);
      assert.ok(
        deliveries.every(
          (entry) =>
            entry.status === 200 &&
            entry.contentType === (stream ? 'text/event-stream' : 'application/json'),
        ),
        'Unexpected response protocol',
      );
      assert.ok(
        (response.usage.inputTokens ?? 0) > 0 && (response.usage.outputTokens ?? 0) > 0,
        'Missing token usage',
      );
      cases.push({
        scenario,
        requests: requests - start,
        deliveries,
        toolExecutions: toolCalls.length,
        output: 'HELLO',
        finalResponseUsage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
      });
      console.error(`Passed: ${scenario}`);
    } finally {
      await agent.value.dispose();
    }
  }
  console.log(
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        model,
        protocol: protocol === 'responses' ? 'openai.responses' : 'openai.chat.completions',
        completionRequests: requests,
        cases,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  // Avoid fetch diagnostics containing configured URLs or credentials.
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : `Provider smoke failed (${error.name})`,
  );
  process.exitCode = 1;
});
