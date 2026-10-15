// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expectProperty } from '../../fixtures/assertions.mjs';
const workspace = mkdtempSync(join(tmpdir(), 'part-consumer-workspace-'));
try {
  writeFileSync(join(workspace, 'input.txt'), 'consumer-owned workspace');
  const input = schema(
    'swe/path',
    /** @param {unknown} value @returns {value is {path: string}} */ (value) =>
      value !== null &&
      typeof value === 'object' &&
      'path' in value &&
      typeof value.path === 'string',
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
