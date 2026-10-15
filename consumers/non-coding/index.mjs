import assert from 'node:assert/strict';
import { createAgent } from '@part/plugins/agent';
import { createAcpAgent } from '@part/plugins/acp';
import { functionTool } from '@part/core/tools';
import { schema, stringSchema } from '@part/core/contracts';
import { fakeModel } from '@part/plugins/testing';
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
const updates = [];
const acp = createAcpAgent({
  connection: {
    async notify(method, params) {
      updates.push({ method, params });
    },
    async request() {
      throw Error('No tools need permission in this consumer');
    },
  },
  configureSession: () => ({ model: fakeModel([{ text: 'Portable ACP' }]) }),
});
await acp.handle('initialize', { protocolVersion: 1, clientCapabilities: {} });
const session = await acp.handle('session/new', { cwd: '/consumer', mcpServers: [] });
assert.equal(
  (
    await acp.handle('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Hello' }],
    })
  ).stopReason,
  'end_turn',
);
assert.equal(
  updates.map((entry) => entry.params.update.content?.text ?? '').join(''),
  'Portable ACP',
);
const cleanup = await acp.close();
assert.deepEqual(cleanup.unresolved, []);
assert.deepEqual(cleanup.errors, []);
console.log('non-coding consumer passed');
