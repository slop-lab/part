// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, localContext } from '@slop-lab/part/contracts';
import { createNodeScripts } from '@slop-lab/part-node/scripts';
import { expectProperty } from '../fixtures/assertions.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} root @param {string} source @param {Partial<import('@slop-lab/part/reference').Scripts.Request>} [options] */
async function start(root, source, options = {}, interpreter = process.execPath) {
  await writeFile(join(root, 'task.cjs'), source);
  const scripts = createNodeScripts({ root, interpreters: { node: interpreter } });
  return expectProperty(
    await scripts.execute(
      {
        requestId: crypto.randomUUID(),
        executorId: 'part/node-process',
        source: {
          relativePath: 'task.cjs',
          digest: await digest(new TextEncoder().encode(source)),
        },
        interpreter: 'node',
        args: [],
        effects: 'read',
        retry: 'never',
        capture: { kind: 'stdout-json', maxBytes: 4096 },
        ...options,
      },
      localContext(),
    ),
    'value',
  );
}

test('Script launch preserves Unicode, empty arguments, quotes, trailing slashes and stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part argv 한글 '));
  try {
    const args = ['', '한글 space', 'a"b', 'ends\\', 'with space\\', '&|%PATH%'];
    const source = `let input=''; process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input:JSON.parse(input)})));`;
    const handle = await start(root, source, { args, stdin: { text: '입력' } });
    const result = expectProperty(await handle.done, 'result');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(expectProperty(result.captured, 'value'), { args, input: { text: '입력' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('An unavailable interpreter is not attempted; a launched script retains its own exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-launch-'));
  try {
    const failed = await start(root, '', { capture: { kind: 'none' } }, join(root, 'missing.exe'));
    const outcome = await failed.done;
    assert.equal(outcome.phase, 'failed');
    assert.equal(outcome.effect, 'not-attempted');
    assert.equal(expectProperty(outcome, 'error').code, 'part.scripts.spawn');
    const exited = await start(root, 'process.exit(127)', { capture: { kind: 'none' } });
    assert.equal(expectProperty(await exited.done, 'result').exitCode, 127);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** @param {number} pid */
async function expectStopped(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (expectProperty(error, 'code') === 'ESRCH') return;
      throw error;
    }
    await pause(10);
  }
  assert.fail(`Script descendant ${pid} survived cleanup`);
}

for (const mode of ['exit', 'cancel', 'timeout']) {
  test(`Script ${mode} cleans up descendants even after the immediate script exits`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'part-tree-'));
    let descendant;
    let handle;
    try {
      const ready = join(root, 'ready.json');
      const descendantSource = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000);`;
      // Windows Job Objects also retain detached descendants. POSIX groups retain attached ones.
      const source = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore',detached:${process.platform === 'win32'}}); child.unref(); ${mode === 'exit' ? `const timer=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(ready)})){clearInterval(timer);console.log('{}');}},5);` : 'setInterval(()=>{},1000);'}`;
      handle = await start(root, source, mode === 'timeout' ? { timeoutMs: 2000 } : {});
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const pid = Number(await readFile(ready, 'utf8'));
          if (pid > 0) {
            descendant = pid;
            break;
          }
        } catch {
          await pause(5);
        }
      }
      assert.ok(descendant, 'The descendant must run before checking cleanup');
      if (mode === 'cancel') await handle.requestCancel('test cancellation');
      const outcome = await handle.done;
      assert.equal(outcome.phase, mode === 'exit' ? 'completed' : 'cancelled');
      assert.deepEqual(outcome.unsettledChildren, []);
      await expectStopped(descendant);
      descendant = undefined;
    } finally {
      await handle?.requestCancel('test cleanup');
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
