// @ts-check
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) continue;
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
    const text = message.params.arguments.text.toUpperCase();
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
