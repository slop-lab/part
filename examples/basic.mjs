import { createAgent } from 'part/agent';
import { functionTool } from 'part/agent/tools';
import { stringSchema } from 'part/contracts';
import { fakeModel } from 'part/testing';

const model = fakeModel([
  { toolCalls: [{ name: 'uppercase', arguments: { text: 'hello' } }] },
  { text: 'HELLO' },
]);
// Runtime validation and provider JSON Schema are separate contracts.
import { schema } from 'part/contracts';
const input = schema(
  'example/text',
  (value) => value !== null && typeof value === 'object' && typeof value.text === 'string',
);
const agent = createAgent({
  model,
  tools: [
    functionTool({
      id: 'uppercase',
      input,
      output: stringSchema,
      execute: ({ text }) => text.toUpperCase(),
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
if (!agent.ok) throw new Error(agent.error.message);
const result = await agent.value.generate('Uppercase hello');
console.log(JSON.stringify(result, null, 2));
await agent.value.dispose();
