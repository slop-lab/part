import { createAcpAgent } from '@part/plugins/acp';
import { startAcpStdio } from '@part/node/acp';
import { connectAcpMcpServers } from '@part/node/acp/mcp';
import { fakeModel } from '@part/plugins/testing';
import { createOpenAIResponsesAdapter } from '@part/plugins/providers/openai-responses';
import { createOpenAICompatibleAdapter } from '@part/plugins/providers/openai-compatible';
import { bearerAuth, createFetchTransport } from '@part/core/model';
import { schema, stringSchema } from '@part/core/contracts';
import { functionTool } from '@part/core/tools';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const provider = process.env.PART_ACP_PROVIDER ?? 'scripted';
if (!['scripted', 'responses', 'chat'].includes(provider))
  throw Error('PART_ACP_PROVIDER must be scripted, responses or chat');
function configuredModel() {
  if (provider === 'scripted')
    return fakeModel([
      { text: 'part ACP is connected. The next prompt demonstrates a tool permission request.' },
      { toolCalls: [{ name: 'save_note', arguments: { text: 'A note approved through ACP.' } }] },
      { text: 'The note was approved and saved in this process memory.' },
      { text: 'The ACP example has completed its scripted turns. Start a new session to repeat.' },
    ]);
  const base = new URL(process.env.R4U_BASE_URL);
  if (
    !process.env.R4U_API_KEY ||
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error('Configure R4U_API_KEY and a valid R4U_BASE_URL');
  base.pathname = base.pathname
    .replace(/\/$/, '')
    .replace(/\/(?:responses|chat\/completions)$/, '');
  const adapter =
    provider === 'responses' ? createOpenAIResponsesAdapter() : createOpenAICompatibleAdapter();
  return {
    profile: {
      id: provider,
      revision: '1',
      adapterId: adapter.id,
      transportId: 'part/fetch',
      authStrategyId: 'bearer',
      model: process.env.R4U_MODEL || 'gpt-6-luna',
      endpoint: `${base}/${provider === 'responses' ? 'responses' : 'chat/completions'}`,
      defaults:
        provider === 'responses' ? { max_output_tokens: 512 } : { max_completion_tokens: 512 },
      capabilities: { revision: '1', entries: [] },
    },
    adapter,
    auth: bearerAuth(async () => process.env.R4U_API_KEY),
    transport: createFetchTransport({
      allowedOrigins: [base.origin],
      fetch(url, init) {
        return fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            ...(process.env.R4U_ROUTE ? { 'X-Router4u-Route': process.env.R4U_ROUTE } : {}),
          },
          signal: AbortSignal.any([init.signal, AbortSignal.timeout(90000)].filter(Boolean)),
        });
      },
    }),
  };
}
const host = startAcpStdio({
  createHandler: (connection) =>
    createAcpAgent({
      connection,
      connectMcp: (setup) =>
        connectAcpMcpServers({ ...setup, allowServer: () => process.env.PART_ACP_MCP === '1' }),
      configureSession() {
        let note = '';
        // Install only explicitly chosen tools. cwd is metadata here, never a chdir or shell command.
        return {
          model: configuredModel(),
          tools: [
            functionTool({
              id: 'save_note',
              description: 'Save a short note in this process memory after approval',
              effects: 'write',
              input: schema(
                'acp/note',
                (value) =>
                  value &&
                  typeof value === 'object' &&
                  typeof value.text === 'string' &&
                  value.text.length <= 4000,
              ),
              output: stringSchema,
              execute: ({ text }) => {
                note = text;
                return note;
              },
            }),
          ],
          toolSchemas: {
            save_note: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        };
      },
    }),
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void host.close();
  });
const report = await host.closed;
if (report.errors.length || report.unresolved.length) {
  console.error('ACP shutdown reported incomplete cleanup.');
  process.exitCode = 1;
}
