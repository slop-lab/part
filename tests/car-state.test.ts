import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { acquireState, recoverStateLock } from '../car/src/state.mjs';
import { cleanupStages } from '../car/src/cleanup.mjs';
import { openCar } from '../car/src/runtime.mjs';
import { resolveCommands } from '../car/src/commands.mjs';
import { createToolsetRpc } from '@slop-lab/part-node/swe/toolset-rpc.js';

test('CAR runs every cleanup stage and retains unresolved evidence when an adapter throws', async () => {
  const visited: string[] = [];
  const result = await cleanupStages([
    {
      name: 'first',
      close() {
        visited.push('first');
        throw new Error('injected');
      },
    },
    {
      name: 'second',
      close() {
        visited.push('second');
      },
    },
    {
      name: 'third',
      async close() {
        visited.push('third');
        return { released: [], unresolved: [], errors: [] };
      },
    },
  ]);
  assert.deepEqual(visited, ['first', 'second', 'third']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.unresolved[0]?.id, 'first');
});

test('CAR releases partial startup ownership and rejects an insecure state directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'car-startup-'));
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(join(stateDirectory, 'artifacts'), 'not a directory');
  try {
    await assert.rejects(openCar({ root, stateDirectory, model: fakeModel([{ text: 'ok' }]) }));
    await assert.rejects(readFile(join(stateDirectory, 'owner.lock')), { code: 'ENOENT' });
    await rm(join(stateDirectory, 'artifacts'));
    const car = await openCar({ root, stateDirectory, model: fakeModel([{ text: 'ok' }]) });
    await car.close();
    if (process.platform !== 'win32') {
      await chmod(stateDirectory, 0o755);
      await assert.rejects(acquireState(stateDirectory, root), /private/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CAR explicit lock recovery refuses a live owner and permits a proven dead owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'car-lock-'));
  try {
    const lease = await acquireState(root, root);
    await assert.rejects(recoverStateLock(root), /still alive/);
    await lease.release({ released: [], unresolved: [], errors: [] });
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    assert.ok(child.pid);
    await writeFile(
      join(root, 'owner.lock'),
      JSON.stringify({ version: 1, pid: child.pid, nonce: 'dead-test-owner' }),
    );
    assert.equal((await recoverStateLock(root)).recovered, true);
    await writeFile(
      join(root, 'owner.lock'),
      JSON.stringify({ version: 1, pid: child.pid, nonce: 'unresolved', unresolved: ['process'] }),
    );
    await assert.rejects(recoverStateLock(root), /unresolved resources/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CAR resolves ordinary host command aliases without copying provider credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'car-commands-'));
  try {
    const policy = await resolveCommands(root);
    assert.equal(policy.commands.node, process.execPath);
    assert.ok(policy.environment.PATH);
    assert.equal('OPENAI_API_KEY' in policy.environment, false);
    assert.equal(policy.environment.HOME, join(root, 'process-home'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('toolset credentials require HTTPS except for loopback test servers', () => {
  assert.throws(
    () => createToolsetRpc({ endpoint: 'http://example.com/rpc', token: 'secret' }),
    /HTTPS/,
  );
  assert.throws(
    () => createToolsetRpc({ endpoint: 'https://user:pass@example.com/rpc', token: 'secret' }),
    /HTTPS/,
  );
});
