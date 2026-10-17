// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createCodingDriver } from '@slop-lab/part-plugins/swe/coding.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { ok } from '@slop-lab/part/contracts/index.js';
import { createWorkspaceTools } from '@slop-lab/part-node/swe/workspace.js';
import { createProcessTools } from '@slop-lab/part-node/swe/process.js';
import { contentDigest, shortLineHash } from '@slop-lab/part-node/swe/hash.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectProperty } from '../../fixtures/assertions.mjs';

const root = mkdtempSync(join(tmpdir(), 'part-consumer-workspace-'));
const processes = createProcessTools({ root });
const workspace = createWorkspaceTools({ root });
const tools = [...workspace.tools, ...processes.tools];
const toolSchemas = { ...workspace.toolSchemas, ...processes.toolSchemas };
writeFileSync(join(root, 'input.txt'), 'before\n');
const model = fakeModel([
  { toolCalls: [{ name: 'swe_read', arguments: { path: 'input.txt' } }] },
  {
    toolCalls: [
      {
        name: 'swe_edit',
        arguments: {
          path: 'input.txt',
          expectedDigest: contentDigest('before\n'),
          edits: [{ line: 1, hash: shortLineHash('before'), newText: 'after' }],
        },
      },
    ],
  },
  {
    toolCalls: [
      {
        name: 'swe_exec',
        arguments: {
          command: process.execPath,
          args: [
            '-e',
            "if(require('node:fs').readFileSync('input.txt','utf8')!=='after\\n')process.exit(1)",
          ],
        },
      },
    ],
  },
  { text: 'Changed and checked.' },
]);
const driver = createCodingDriver({
  profileId: model.profile.id,
  tools: tools.map((tool) => ({
    id: tool.id,
    version: tool.version,
    description: tool.id,
    inputSchema: toolSchemas[tool.id] ?? {},
    execution: 'runtime',
  })),
  validate: async () =>
    ok({
      summary: 'workspace verification',
      checks: [
        { id: 'file-content', passed: readFileSync(join(root, 'input.txt'), 'utf8') === 'after\n' },
      ],
    }),
});
const agent = expectProperty(createAgent({ model, tools, toolSchemas, driver }), 'value');
try {
  const outcome = expectProperty(await agent.generate('Change and verify the file'), 'value');
  assert.equal(outcome.phase, 'completed');
  assert.equal(readFileSync(join(root, 'input.txt'), 'utf8'), 'after\n');
  console.log('swe packed consumer: read, hash edit, real process and completion gate passed');
} finally {
  await agent.dispose();
  const cleanup = await processes.close();
  assert.deepEqual(cleanup.unresolved, []);
  rmSync(root, { recursive: true, force: true });
}
