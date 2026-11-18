// @ts-check
import { startAcpStdio } from '@slop-lab/part-node/acp/index.js';
import { connectAcpMcpServers } from '@slop-lab/part-node/acp/mcp.js';
import { createAcpAgent } from '@slop-lab/part-plugins/acp/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import { createExampleOpenAIModel } from '../openai-provider.mjs';

try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const provider = process.env.PART_ACP_PROVIDER ?? 'scripted';
if (provider !== 'scripted' && provider !== 'responses' && provider !== 'chat')
  throw Error('PART_ACP_PROVIDER must be scripted, responses or chat');
/** @returns {import("@slop-lab/part/reference/index.js").Convenience.ConfiguredModel} */
function configuredModel() {
  if (provider === 'scripted')
    return fakeModel([
      { text: 'part ACP is connected. The next prompt demonstrates a tool permission request.' },
      { toolCalls: [{ name: 'save_note', arguments: { text: 'A note approved through ACP.' } }] },
      { text: 'The note was approved and saved in this process memory.' },
      { text: 'The ACP example has completed its scripted turns. Start a new session to repeat.' },
    ]);
  return createExampleOpenAIModel(process.env, {
    protocol: provider === 'responses' ? 'responses' : 'chat',
  });
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
                /** @param {unknown} value @returns {value is {text: string}} */ (value) =>
                  value !== null &&
                  typeof value === 'object' &&
                  'text' in value &&
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
