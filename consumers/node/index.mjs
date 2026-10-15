import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, localContext } from '@part/core/contracts';
import { createNodeScripts } from '@part/node/scripts';
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
  console.log('node-only adapter consumer passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
