import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, contextPoint } from '../dist/agent.js';
import { functionTool } from '../dist/tools.js';
import { fakeModel } from '../dist/testing.js';
import { schema, stringSchema, ok, fail } from '../dist/contracts.js';
import { createBasicDriver, createValidatingDriver } from '../dist/driver-basic.js';
import { createContextCompiler } from '../dist/context.js';
const input = schema('test/text', v => v && typeof v === 'object' && typeof v.text === 'string');
const toolSchemas = { echo: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
test('G02: minimal non-coding input -> model -> function tool -> result', async () => {
  let count = 0;
  const model = fakeModel([{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { text: 'finished' }]);
  const agent = createAgent({ model, tools: [functionTool({ id: 'echo', input, output: stringSchema, execute: ({ text }) => { count++; return text; } })], toolSchemas }).value;
  const result = await agent.generate('hello'); assert.equal(result.ok, true); assert.equal(result.value.phase, 'completed'); assert.equal(result.value.result.content[0].text, 'finished'); assert.equal(count, 1); assert.equal(model.requests.length, 2);
  const second = JSON.parse(new TextDecoder().decode(model.requests[1].body)); assert.equal(second.messages.at(-1).role, 'tool'); assert.equal(second.messages.at(-1).content, '"hello"');
  await agent.dispose();
});
test('C02/C08: runtime configuration and model request histories remain isolated', async () => {
  const left = fakeModel([{ text: 'left' }]), right = fakeModel([{ text: 'right' }]);
  const a = createAgent({ model: left }).value, b = createAgent({ model: right }).value;
  const revision = a.inspectComposition().revision; left.profile.model = 'mutated';
  const [l,r] = await Promise.all([a.generate('left input'), b.generate('right input')]);
  assert.equal(l.value.result.content[0].text, 'left'); assert.equal(r.value.result.content[0].text, 'right');
  assert.equal(JSON.parse(new TextDecoder().decode(left.requests[0].body)).model, 'fixture'); assert.equal(a.inspectComposition().revision, revision);
  await Promise.all([a.dispose(), b.dispose()]);
});
test('G08/E11: a second driver can reject completion after provider stop', async () => {
  const model = fakeModel([{ text: 'stop is insufficient' }]);
  const driver = createValidatingDriver(createBasicDriver({ profileId: 'fake' }), stringSchema, async () => fail('validator', 'Completion rejected'));
  const agent = createAgent({ model, driver }).value; const result = await agent.generate('input');
  assert.equal(result.value.phase, 'failed'); assert.equal(result.value.error.code, 'part.validator'); await agent.dispose();
});
test('G06/G07: replacing the middle context service preserves the convenience agent', async () => {
  let calls = 0;
  const original = createContextCompiler().value, replacement = { compile: async (...args) => { calls++; return original.compile(...args); } };
  const agent = createAgent({ model: fakeModel([{ text: 'ok' }]), customize: spec => ({ ...spec, edits: [registry => registry.replace({ point: { ...contextPoint }, replaces: 'part/base-context', with: { id: 'part/base-context', point: contextPoint, value: replacement } })] }) }).value;
  assert.equal((await agent.generate('input')).value.phase, 'completed'); assert.equal(calls, 1); await agent.dispose();
});
test('shared invocation/attempt budgets stop the next effect before execution', async () => {
  let count = 0; const model = fakeModel([{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { text: 'never' }]);
  const agent = createAgent({ model, tools: [functionTool({ id: 'echo', input, output: stringSchema, execute: () => { count++; return 'done'; } })], toolSchemas, limits: { maxExecutorAttempts: 1, maxModelInvocations: 5 } }).value;
  const result = await agent.generate('input'); assert.equal(result.value.phase, 'failed'); assert.equal(count, 0); assert.equal(model.requests.length, 1); await agent.dispose();
});
