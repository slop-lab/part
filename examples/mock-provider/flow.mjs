// @ts-check
import { expectProperty } from '../../fixtures/assertions.mjs';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import { bearerAuth, createFetchTransport } from '@slop-lab/part/model/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import { schema, stringSchema } from '@slop-lab/part/contracts/index.js';
export const prompt = 'Uppercase hello using the uppercase tool.';
export function createMockFlow(session) {
  const toolExecutions = [];
  const agent = createAgent({
    model: {
      profile: {
        id: 'mock',
        revision: '1',
        adapterId: 'part/openai-compatible',
        transportId: 'part/fetch',
        authStrategyId: 'bearer',
        model: 'part-mock',
        endpoint: `${session.baseURL}/chat/completions`,
        defaults: {},
        capabilities: { revision: '1', entries: [] },
      },
      adapter: createOpenAICompatibleAdapter(),
      transport: createFetchTransport({ allowedOrigins: [new URL(session.baseURL).origin] }),
      auth: bearerAuth(async () => session.apiKey),
    },
    tools: [
      functionTool({
        id: 'uppercase',
        description: 'Convert text to uppercase',
        input: schema(
          'mock/text',
          /** @param {unknown} value @returns {value is {text: string}} */ (value) =>
            value !== null &&
            typeof value === 'object' &&
            'text' in value &&
            typeof value.text === 'string',
        ),
        output: stringSchema,
        execute: ({ text }) => {
          const result = text.toUpperCase();
          toolExecutions.push({ tool: 'uppercase', input: { text }, output: result });
          return result;
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
  });
  if (agent.ok === false) throw Error(expectProperty(agent, 'error').message);
  return {
    async run() {
      const result = await agent.value.generate(prompt);
      if (!result.ok || result.value.phase !== 'completed') throw Error(JSON.stringify(result));
      return {
        toolExecutions,
        output: result.value.result.content
          .filter((part) => part.kind === 'text')
          .map((part) => part.text)
          .join(''),
      };
    },
    dispose: () => agent.value.dispose(),
  };
}
