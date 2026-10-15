// @ts-check
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  /** @type {unknown} */
  const message = JSON.parse(line);
  assert.ok(message !== null && typeof message === 'object');
  if (!('id' in message) || !('method' in message)) continue;
  let result;
  if (message.method === 'initialize')
    result = {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'part-mcp-fixture', version: '1' },
      capabilities: { tools: {} },
    };
  if (message.method === 'tools/list')
    result = {
      tools: [
        {
          name: 'echo',
          description: 'Uppercase fixture text',
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
    };
  if (message.method === 'tools/call') {
    if (process.env.PART_MCP_MARKER) appendFileSync(process.env.PART_MCP_MARKER, 'called\n');
    assert.ok('params' in message && message.params !== null && typeof message.params === 'object');
    const params = message.params;
    assert.ok(
      'arguments' in params && params.arguments !== null && typeof params.arguments === 'object',
    );
    assert.ok('text' in params.arguments && typeof params.arguments.text === 'string');
    const text = params.arguments.text.toUpperCase();
    result = {
      content: [{ type: 'text', text }],
      structuredContent: { result: text, hostSecretPresent: !!process.env.PART_MCP_NOT_INHERITED },
    };
  }
  process.stdout.write(
    JSON.stringify(
      result
        ? { jsonrpc: '2.0', id: message.id, result }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } },
    ) + '\n',
  );
}
