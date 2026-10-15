import assert from 'node:assert/strict';
import { createAgent } from 'part/agent';
import { functionTool } from 'part/agent/tools';
import { schema, stringSchema } from 'part/contracts';
import { fakeModel } from 'part/testing';
const input = schema(
  'consumer/text',
  (value) => value && typeof value === 'object' && typeof value.text === 'string',
);
const model = fakeModel([
  { toolCalls: [{ name: 'uppercase', arguments: { text: 'hello' } }] },
  { text: 'HELLO' },
]);
const created = createAgent({
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
    uppercase: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
});
assert.equal(created.ok, true);
assert.equal(
  (await created.value.generate('uppercase hello')).value.result.content[0].text,
  'HELLO',
);
await created.value.dispose();
console.log('non-coding consumer passed');
