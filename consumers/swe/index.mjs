import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createAgent } from '@part/plugins/agent';
import { functionTool } from '@part/core/tools';
import { schema, stringSchema } from '@part/core/contracts';
import { fakeModel } from '@part/plugins/testing';
const workspace = mkdtempSync(join(tmpdir(), 'part-consumer-workspace-'));
try {
  writeFileSync(join(workspace, 'input.txt'), 'consumer-owned workspace');
  const input = schema(
    'swe/path',
    (value) => value && typeof value === 'object' && typeof value.path === 'string',
  );
  let reads = 0;
  const read = functionTool({
    id: 'workspace-read',
    input,
    output: stringSchema,
    execute: ({ path }) => {
      const file = resolve(workspace, path),
        local = relative(workspace, file);
      if (local.startsWith('..') || resolve(file) === resolve(workspace))
        throw Error('Outside workspace');
      reads++;
      return readFileSync(file, 'utf8');
    },
  });
  const agent = createAgent({
    model: fakeModel([
      { toolCalls: [{ name: 'workspace-read', arguments: { path: 'input.txt' } }] },
      { text: 'read complete' },
    ]),
    tools: [read],
    toolSchemas: {
      'workspace-read': {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  }).value;
  assert.equal((await agent.generate('read the file')).value.phase, 'completed');
  assert.equal(reads, 1);
  await agent.dispose();
  console.log('swe consumer passed');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
