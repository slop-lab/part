// @ts-check
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const live = process.argv.includes('--live'),
  approve = process.argv.includes('--approve');
if (live && !['responses', 'chat'].includes(process.env.PART_ACP_PROVIDER))
  throw Error('Set PART_ACP_PROVIDER=responses or chat when using --live');
const child = spawn(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url))], {
  env: { ...process.env, PART_ACP_PROVIDER: live ? process.env.PART_ACP_PROVIDER : 'scripted' },
  stdio: ['pipe', 'pipe', 'inherit'],
  timeout: live ? 120000 : 10000,
});
const exited = once(child, 'exit');
let chunks = 0,
  toolCalls = 0,
  permissions = 0;
try {
  await client({ name: 'part-acp-example' })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (
        params.update.sessionUpdate === 'agent_message_chunk' &&
        params.update.content.type === 'text'
      ) {
        chunks++;
        process.stdout.write(params.update.content.text);
      }
      if (params.update.sessionUpdate === 'tool_call') toolCalls++;
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions++;
      const option = params.options.find(
        (entry) => entry.kind === (approve ? 'allow_once' : 'reject_once'),
      );
      console.error(
        `\nPermission: ${params.toolCall.title} → ${approve ? 'allow once' : 'reject'}`,
      );
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    })
    .connectWith(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
      async (context) => {
        const initialized = await context.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        console.error(
          `Connected to ${initialized.agentInfo.name} (ACP ${initialized.protocolVersion}).`,
        );
        const session = await context.request(methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: [],
        });
        const prompts = live
          ? ['Reply with exactly ACP_OK.']
          : ['Hello from the ACP client.', 'Save a short note.'];
        for (const text of prompts) {
          try {
            const result = await context.request(methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text }],
            });
            console.log(`\nStop: ${result.stopReason}`);
          } catch (error) {
            if (error.data?.code === 'part.acp.denied')
              console.log('\nPermission rejected; the tool was not executed.');
            else throw error;
          }
        }
        await context.request(methods.agent.session.close, { sessionId: session.sessionId });
      },
    );
  child.stdin.end();
  const [code] = await exited;
  if (code !== 0) throw Error('ACP agent did not exit successfully');
  console.log(
    JSON.stringify({
      provider: live ? process.env.PART_ACP_PROVIDER : 'scripted',
      textChunks: chunks,
      toolCalls,
      permissions,
    }),
  );
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
}
