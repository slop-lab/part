// @ts-check
import { connectLocalToolsetCheckout } from '../car/src/infrastructure.mjs';
import { connectAcpMcpServers } from '@slop-lab/part-node/acp/mcp.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('local checkout connector launches only an existing MCP build with fixed root and allowlist', async () => {
  // Given
  const checkout = await mkdtemp(join(tmpdir(), 'part-toolset-'));
  const root = await mkdtemp(join(tmpdir(), 'part-car-root-'));
  /** @type {Parameters<typeof connectAcpMcpServers>[0][]} */
  const calls = [];
  await mkdir(join(checkout, 'dist'));
  await writeFile(join(checkout, 'dist', 'mcp.js'), '// built fixture');
  const returned = {
    tools: [],
    toolSchemas: {},
    executors: [],
    close: async () => ({ released: [], unresolved: [], errors: [] }),
  };
  try {
    // When
    const connected = await connectLocalToolsetCheckout({
      checkout,
      root,
      allowedTools: ['builtin.read', 'builtin.stat'],
      path: '/explicit/bin',
      connect: async (options) => {
        calls.push(options);
        return returned;
      },
    });

    // Then
    assert.equal(connected, returned);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.deepEqual(calls, [
      {
        cwd: root,
        mcpServers: [
          {
            name: 'agent_tools',
            command: process.execPath,
            args: [join(checkout, 'dist', 'mcp.js')],
            env: [
              { name: 'AGENT_TOOL_ROOT', value: root },
              { name: 'AGENT_TOOL_ALLOWED_TOOLS', value: '["builtin.read","builtin.stat"]' },
              { name: 'AGENT_TOOL_PRINCIPAL', value: 'part-car' },
              { name: 'AGENT_TOOL_WORKSPACE', value: 'local' },
              { name: 'AGENT_TOOL_STATE', value: ':memory:' },
              { name: 'AGENT_TOOL_PROFILE', value: 'p0' },
            ],
          },
        ],
        environment: { PATH: '/explicit/bin' },
        allowServer: firstCall.allowServer,
      },
    ]);
    const firstServer = firstCall.mcpServers[0];
    assert.ok(firstServer);
    assert.equal(await firstCall.allowServer(firstServer), true);
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('local checkout connector does not build missing output and supports explicit published commands', async () => {
  // Given
  const checkout = await mkdtemp(join(tmpdir(), 'part-toolset-'));
  const root = await mkdtemp(join(tmpdir(), 'part-car-root-'));
  /** @type {Parameters<typeof connectAcpMcpServers>[0][]} */
  const calls = [];
  try {
    // When / Then
    await assert.rejects(
      connectLocalToolsetCheckout({
        checkout,
        root,
        allowedTools: [],
        connect: async () => assert.fail(),
      }),
      /built MCP entry/i,
    );
    await connectLocalToolsetCheckout({
      root,
      allowedTools: [],
      executable: '/opt/toolset/bin/toolset',
      executableArgs: ['mcp'],
      connect: async (options) => {
        calls.push(options);
        return {
          tools: [],
          toolSchemas: {},
          executors: [],
          close: async () => ({ released: [], unresolved: [], errors: [] }),
        };
      },
    });
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.deepEqual(firstCall.mcpServers[0]?.args, ['mcp']);
  } finally {
    await rm(checkout, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
