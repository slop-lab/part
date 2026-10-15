// @ts-check
import { expectProperty } from '../../fixtures/assertions.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createAgent } from '@slop-lab/part-plugins/agent';
import { functionTool } from '@slop-lab/part/tools';
import { schema, stringSchema } from '@slop-lab/part/contracts';
import { fakeModel } from '@slop-lab/part-plugins/testing';
const workspace = mkdtempSync(join(tmpdir(), 'part-consumer-workspace-'));
try {
  writeFileSync(join(workspace, 'input.txt'), 'consumer-owned workspace');
  const input = schema(
    'swe/path',
    /** @param {unknown} value @returns {value is {path: string}} */ (value) =>
      value && typeof value === 'object' && 'path' in value && typeof value.path === 'string',
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
  const agent = expectProperty(
    createAgent({
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
    }),
    'value',
  );
  assert.equal(expectProperty(await agent.generate('read the file'), 'value').phase, 'completed');
  assert.equal(reads, 1);
  await agent.dispose();
  console.log('swe consumer passed');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
