import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, localContext } from '@part/core/contracts';
import { createNodeScripts } from '@part/node/scripts';
import { startMockProvider } from '@part/node/testing/mock-provider';
import { createMockProviderTools } from '@part/node/testing/mock-provider/tools';
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
  console.log('node-only adapter consumer passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
