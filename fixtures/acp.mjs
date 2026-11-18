// @ts-check
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk';
import { startAcpStdio } from '@slop-lab/part-node/acp/index.js';
import { createAcpAgent } from '@slop-lab/part-plugins/acp/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import { PassThrough, Writable } from 'node:stream';
import { byteStream } from '../examples/acp/streams.mjs';

const textSchema = schema(
  'acp/text',
  /** @param {unknown} value @returns {value is {text: string}} */ (value) =>
    value !== null &&
    typeof value === 'object' &&
    'text' in value &&
    typeof value.text === 'string',
);
const parameters = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
/** @param {import("@agentclientprotocol/sdk").ClientContext} cx */
export const initialize = (cx) =>
  cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
/** @param {import("@agentclientprotocol/sdk").ClientContext} cx */
export const newSession = (cx) =>
  cx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
/** @param {import("@agentclientprotocol/sdk").ClientContext} cx @param {string} sessionId @param {string} text */
export const prompt = (cx, sessionId, text = 'hello') =>
  cx.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
/** @param {string[]} executions @param {import('@slop-lab/part/reference/index.js').Tools.Definition<unknown, unknown>['effects']} [effects] */
export function toolOptions(executions, effects = 'write') {
  return {
    model: fakeModel([
      { toolCalls: [{ name: 'save_note', arguments: { text: 'hello' } }] },
      { text: 'Saved.' },
    ]),
    tools: [
      functionTool({
        id: 'save_note',
        description: 'Save a note',
        effects,
        input: textSchema,
        output: stringSchema,
        execute: ({ text }) => {
          executions.push(text);
          return text;
        },
      }),
    ],
    toolSchemas: { save_note: parameters },
  };
}
/**
 * @import {ClientContext, RequestPermissionRequest, RequestPermissionResponse, SessionNotification} from '@agentclientprotocol/sdk'
 * @import {AcpAgentOptions} from '@slop-lab/part-plugins/acp/index.js'
 * @typedef {{
 *   configureSession: AcpAgentOptions['configureSession'],
 *   permission?: (params: RequestPermissionRequest, signal: AbortSignal) => RequestPermissionResponse | Promise<RequestPermissionResponse>,
 *   options?: Partial<AcpAgentOptions>,
 *   transport?: Partial<Parameters<typeof startAcpStdio>[0]>
 * }} SdkSettings
 */
/**
 * @param {SdkSettings} settings
 * @param {(cx: ClientContext, state: {updates: SessionNotification[], requests: RequestPermissionRequest[], host: ReturnType<typeof startAcpStdio>}) => Promise<void>} run
 */
export async function withSdk(
  {
    configureSession,
    permission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    options = {},
    transport = {},
  },
  run,
) {
  const input = new PassThrough(),
    output = new PassThrough(),
    /** @type {import("@agentclientprotocol/sdk").SessionNotification[]} */
    updates = [],
    /** @type {import("@agentclientprotocol/sdk").RequestPermissionRequest[]} */
    requests = [];
  const host = startAcpStdio({
    ...transport,
    input,
    output,
    createHandler: (connection) => createAcpAgent({ ...options, connection, configureSession }),
  });
  try {
    await client({ name: 'part-conformance' })
      .onRequest(methods.client.session.requestPermission, (ctx) => {
        requests.push(ctx.params);
        return permission(ctx.params, ctx.signal);
      })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params);
      })
      .connectWith(ndJsonStream(Writable.toWeb(input), byteStream(output)), (cx) =>
        run(cx, { updates, requests, host }),
      );
  } finally {
    await host.close();
    output.destroy();
  }
}
