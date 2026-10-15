import assert from 'node:assert/strict';
import { createAgent } from '@slop-lab/part-plugins/agent';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible';
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses';
import { bearerAuth, createFetchTransport } from '@slop-lab/part/model';
import { schema, stringSchema } from '@slop-lab/part/contracts';
import { functionTool } from '@slop-lab/part/tools';

// Opt-in only: never run as part of the credential-free test suite.
async function main() {
  const protocol = process.argv[2] ?? 'chat';
  assert.ok(['chat', 'responses'].includes(protocol), 'Expected chat or responses protocol');
  const adapter =
    protocol === 'responses' ? createOpenAIResponsesAdapter() : createOpenAICompatibleAdapter();
  const path = protocol === 'responses' ? 'responses' : 'chat/completions';
  const key = process.env.R4U_API_KEY;
  assert.ok(key && process.env.R4U_BASE_URL, 'R4U_API_KEY and R4U_BASE_URL are required');
  const base = new URL(process.env.R4U_BASE_URL);
  assert.ok(['http:', 'https:'].includes(base.protocol), 'Expected HTTP(S) base URL');
  assert.ok(
    !base.username && !base.password && !base.search && !base.hash,
    'Use bearer authentication without URL credentials',
  );
  base.pathname = base.pathname
    .replace(/\/$/, '')
    .replace(/\/(?:chat\/completions|responses)$/, '');
  const headers = {
    authorization: `Bearer ${key}`,
    ...(process.env.R4U_ROUTE ? { 'X-Router4u-Route': process.env.R4U_ROUTE } : {}),
  };
  const capabilityResponse = await fetch(`${base}/capabilities`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(capabilityResponse.status, 200, 'R4U capability discovery failed');
  const { routes } = await capabilityResponse.json();
  const route = process.env.R4U_ROUTE
    ? routes?.find((entry) => entry.id === process.env.R4U_ROUTE)
    : routes?.length === 1
      ? routes[0]
      : undefined;
  assert.ok(route, 'Set R4U_ROUTE when the project has multiple routes');
  assert.ok(
    route.protocols?.includes(protocol),
    `R4U route does not support the selected protocol: ${protocol}`,
  );
  const listing = await fetch(`${base}/models`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(listing.status, 200, 'Model discovery failed');
  const models = (await listing.json()).data;
  assert.ok(Array.isArray(models), 'Expected model list');
  const model = process.env.R4U_MODEL ?? 'gpt-6-luna';
  assert.ok(
    models.some((entry) => entry.id === model),
    'Set R4U_MODEL to an available text/tool model',
  );
  let requests = 0;
  const cases = [];
  for (const scenario of ['text-json', 'text-sse', 'tool-sse']) {
    const stream = scenario !== 'text-json';
    const toolCalls = [];
    const deliveries = [];
    const start = requests;
    const agent = createAgent({
      limits: {
        maxModelInvocations: scenario === 'tool-sse' ? 2 : 1,
        maxToolDispatches: 1,
        deadline: new Date(Date.now() + 120000).toISOString(),
      },
      model: {
        profile: {
          id: 'r4u-smoke',
          revision: '1',
          adapterId: adapter.id,
          transportId: 'part/fetch',
          authStrategyId: 'bearer',
          model,
          endpoint: `${base}/${path}`,
          defaults: {
            stream,
            ...(protocol === 'responses'
              ? { max_output_tokens: 256 }
              : { max_completion_tokens: 256 }),
          },
          capabilities: { revision: '1', entries: [] },
        },
        adapter,
        transport: createFetchTransport({
          allowedOrigins: [base.origin],
          async fetch(url, init) {
            assert.ok(++requests <= 4, 'Smoke request limit exceeded');
            const response = await fetch(url, {
              ...init,
              headers: { ...init.headers, ...headers },
              signal: AbortSignal.any([init.signal, AbortSignal.timeout(90000)].filter(Boolean)),
            });
            deliveries.push({
              status: response.status,
              contentType: response.headers.get('content-type')?.split(';')[0],
            });
            return response;
          },
        }),
        auth: bearerAuth(async () => key),
      },
      ...(scenario === 'tool-sse'
        ? {
            tools: [
              functionTool({
                id: 'uppercase',
                description: 'Convert text to uppercase. Use this tool when asked.',
                input: schema(
                  'smoke/text',
                  (value) => value !== null && typeof value === 'object' && value.text === 'hello',
                ),
                output: stringSchema,
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
      assert.ok(result.ok, `${scenario}: ${result.error?.code ?? 'execution failed'}`);
      assert.equal(
        result.value.phase,
        'completed',
        `${scenario}: ${result.value.error?.code ?? result.value.phase}; HTTP ${deliveries.map((entry) => entry.status).join(',')}`,
      );
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
        response.usage.inputTokens > 0 && response.usage.outputTokens > 0,
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
        discoveredModels: models.length,
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
