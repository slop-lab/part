// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createProviderModel } from '@slop-lab/part-plugins/providers/index.js';

const protocol = process.argv[2] ?? 'responses';
if (protocol !== 'chat' && protocol !== 'responses' && protocol !== 'messages')
  throw new Error('Choose chat, responses or messages');
const target = process.env.PART_MODEL;
if (!target) throw new Error('Set PART_MODEL to a model supported by the endpoint');

const model = createProviderModel({
  protocol,
  baseURL: process.env.PART_BASE_URL,
  apiKey:
    process.env.PART_API_KEY ??
    (protocol === 'messages' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY),
  model: 'default',
  modelMap: { default: target },
  timeoutMs: 90_000,
});
const agent = createAgent({ model });
if (!agent.ok) throw new Error(agent.error.message);
try {
  const result = await agent.value.generate(process.argv[3] ?? 'Say hello.');
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.phase !== 'completed')
    throw new Error(result.value.error?.message ?? `Model run ${result.value.phase}`);
  for (const part of result.value.result.content) if (part.kind === 'text') console.log(part.text);
} finally {
  await agent.value.dispose();
}
