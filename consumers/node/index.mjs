import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { digest, localContext } from '@part/core/contracts';
import { createNodeScripts } from '@part/node/scripts';
import { startMockProvider } from '@part/node/testing/mock-provider';
import { createMockProviderTools } from '@part/node/testing/mock-provider/tools';
import { startAcpStdio } from '@part/node/acp';
import { connectAcpMcpServers } from '@part/node/acp/mcp';
const root = await mkdtemp(join(tmpdir(), 'part-node-consumer-'));
try {
  const bytes = new TextEncoder().encode('process.stdout.write(JSON.stringify({ value: 42 }))');
  await writeFile(join(root, 'task.cjs'), bytes);
  const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } });
  const started = await scripts.execute(
    {
      requestId: 'consumer/script',
      executorId: 'part/node-process',
      source: { relativePath: 'task.cjs', digest: await digest(bytes) },
      interpreter: 'node',
      args: [],
      effects: 'read',
      retry: 'never',
      capture: { kind: 'stdout-json', maxBytes: 1024 },
    },
    localContext(),
  );
  assert.equal(started.ok, true);
  const outcome = await started.value.done;
  assert.equal(outcome.phase, 'completed');
  assert.deepEqual(outcome.result.captured.value, { value: 42 });
  const request = { model: 'part-mock', messages: [{ role: 'user', content: 'packaged mock' }] };
  const mock = await startMockProvider({
    mode: 'fixed',
    project: { id: 'consumer/node' },
    fixture: {
      schemaVersion: 1,
      name: 'packaged-mock',
      exchanges: [
        { id: 'hello', request, reply: { kind: 'completion', content: 'packaged response' } },
      ],
    },
  });
  try {
    const response = await fetch(`${mock.session.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mock.session.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    assert.equal((await response.json()).choices[0].message.content, 'packaged response');
    mock.verify();
    assert.equal(typeof createMockProviderTools, 'function');
  } finally {
    await mock.close();
  }
  const input = new PassThrough(),
    output = new PassThrough();
  const peer = startAcpStdio({
    input,
    output,
    createHandler: () => ({
      async handle(method, params) {
        return { method, params };
      },
      async close() {
        return { released: [], unresolved: [], errors: [] };
      },
    }),
  });
  const reply = new Promise((resolve) => output.once('data', resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'consumer', params: {} }) + '\n');
  assert.equal(JSON.parse((await reply).toString()).result.method, 'consumer');
  await peer.close();
  const mcp = await connectAcpMcpServers({ cwd: root, mcpServers: [], allowServer: () => false });
  assert.deepEqual((await mcp.close()).unresolved, []);
  console.log('node-only adapter consumer passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
