// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('The test reporter hides successful and skipped names while preserving failures, counts and exit status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-reporter-'));
  const reporter = new URL('../scripts/test-reporter.mjs', import.meta.url).href;
  try {
    const fixture = join(root, 'fixture.mjs');
    for (const fail of [false, true]) {
      await writeFile(
        fixture,
        `import test from 'node:test'; import assert from 'node:assert/strict';
        test('hidden success', async t => { await t.test('hidden nested success',()=>{}); });
        test('hidden skipped', {skip:true}, ()=>{});
        ${fail ? "test('visible failure',()=>assert.equal(1,2));" : ''}`,
      );
      const result = spawnSync(
        process.execPath,
        ['--test', `--test-reporter=${reporter}`, fixture],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      if (result.error) throw result.error;
      assert.equal(result.status, fail ? 1 : 0, result.stderr);
      assert.doesNotMatch(result.stdout, /hidden success|hidden nested success|hidden skipped/);
      assert.match(result.stdout, /pass 2/);
      assert.match(result.stdout, /skipped 1/);
      assert.match(result.stdout, new RegExp(`fail ${fail ? 1 : 0}`));
      if (fail) {
        assert.match(result.stdout, /visible failure/);
        assert.match(result.stdout, /AssertionError/);
        assert.match(result.stdout, /1 !== 2/);
        assert.match(result.stdout, /fixture\.mjs/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
