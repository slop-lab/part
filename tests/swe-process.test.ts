import { createMemoryArtifacts } from '@slop-lab/part/artifacts/index.js';
import { fail, isJsonObject, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
import { createProcessTools } from '@slop-lab/part-node/swe/process.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatch(dispatcher: Tools.Dispatcher, id: string, args: Contracts.Json) {
  const started = await dispatcher.dispatch(
    { logicalCallId: crypto.randomUUID(), toolId: id, arguments: args },
    localContext(),
  );
  assert.equal(started.ok, true, JSON.stringify(started));
  const outcome = await started.value.done;
  assert.equal(outcome.phase, 'completed', JSON.stringify(outcome));
  assert.ok(isJsonObject(outcome.result.value));
  return outcome.result.value;
}

async function waitFor(dispatcher: Tools.Dispatcher, processId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await dispatch(dispatcher, 'swe_process_status', { processId });
    if (status.status !== 'running') return status;
    await pause(10);
  }
  assert.fail('process did not settle');
}

async function expectStopped(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return;
      throw error;
    }
    await pause(10);
  }
  assert.fail(`descendant ${pid} survived cleanup`);
}

test('SWE process tools preserve argv, isolate credentials, bound reads and publish full artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-process-'));
  const artifacts = createMemoryArtifacts();
  const registration = createProcessTools({
    root,
    artifacts,
    environment: { SAFE_VALUE: 'visible' },
    maxOutputBytes: 128,
    maxInlineBytes: 16,
  });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  process.env.PART_TEST_CREDENTIAL = 'must-not-leak';
  try {
    const started = await dispatch(created.value, 'swe_process_start', {
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write(JSON.stringify({args:process.argv.slice(1),safe:process.env.SAFE_VALUE,secret:process.env.PART_TEST_CREDENTIAL})+'x'.repeat(100))",
        'hello world',
      ],
    });
    const processId = started.processId;
    assert.ok(typeof processId === 'string');
    const status = await dispatch(created.value, 'swe_process_wait', { processId });
    assert.equal(status.status, 'exited');
    assert.equal(status.exitCode, 0);
    assert.equal(status.truncated, true);
    const artifactRef = status.artifact;
    assert.ok(isJsonObject(artifactRef));
    const artifactStore = artifactRef.store;
    const artifactId = artifactRef.id;
    assert.ok(typeof artifactStore === 'string');
    assert.ok(typeof artifactId === 'string');
    const first = await dispatch(created.value, 'swe_process_read', {
      processId,
      stream: 'stdout',
      offset: 0,
      limit: 999,
    });
    const firstBytes = first.bytes;
    const nextOffset = first.nextOffset;
    assert.equal(first.encoding, 'base64');
    assert.ok(typeof firstBytes === 'string');
    assert.ok(typeof nextOffset === 'number');
    const firstChunk = Buffer.from(firstBytes, 'base64');
    assert.equal(firstChunk.length <= 16, true);
    assert.equal(nextOffset, firstChunk.length);
    const second = await dispatch(created.value, 'swe_process_read', {
      processId,
      stream: 'stdout',
      offset: nextOffset,
      limit: 16,
    });
    const secondBytes = second.bytes;
    assert.ok(typeof secondBytes === 'string');
    const secondChunk = Buffer.from(secondBytes, 'base64');
    assert.match(Buffer.concat([firstChunk, secondChunk]).toString('utf8'), /hello world/);
    const loaded = await artifacts.read(
      { store: artifactStore, id: artifactId },
      undefined,
      localContext(),
    );
    assert.equal(loaded.ok, true);
    let artifact = '';
    for await (const chunk of loaded.value) artifact += new TextDecoder().decode(chunk);
    assert.match(artifact, /"safe":"visible"/);
    assert.equal(artifact.includes('must-not-leak'), false);
  } finally {
    delete process.env.PART_TEST_CREDENTIAL;
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE exec waits, reports nonzero exits, and propagates caller cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-exec-'));
  const registration = createProcessTools({ root });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    const exited = await dispatch(created.value, 'swe_exec', {
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
    });
    assert.equal(exited.status, 'exited');
    assert.equal(exited.exitCode, 7);
    assert.equal(exited.success, false);
    const running = await created.value.dispatch(
      {
        logicalCallId: crypto.randomUUID(),
        toolId: 'swe_exec',
        arguments: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      },
      localContext(),
    );
    assert.equal(running.ok, true);
    await running.value.requestCancel('test caller cancellation');
    assert.equal((await running.value.done).phase, 'cancelled');
  } finally {
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE process reads preserve arbitrary bytes and artifact failures are observable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-bytes-'));
  const artifacts = {
    async create() {
      return fail('artifact.test', 'test store unavailable', 'unavailable');
    },
    async read() {
      return fail('artifact.test', 'test store unavailable', 'unavailable');
    },
  };
  const registration = createProcessTools({ root, artifacts, maxInlineBytes: 2 });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    const started = await dispatch(created.value, 'swe_process_start', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([255,0,128,65]))'],
    });
    const processId = started.processId;
    assert.ok(typeof processId === 'string');
    const status = await dispatch(created.value, 'swe_process_wait', { processId });
    assert.equal(status.artifactError, 'part.artifact.test');
    const first = await dispatch(created.value, 'swe_process_read', { processId, limit: 2 });
    const second = await dispatch(created.value, 'swe_process_read', {
      processId,
      offset: 2,
      limit: 2,
    });
    const firstBytes = first.bytes;
    const secondBytes = second.bytes;
    assert.ok(typeof firstBytes === 'string');
    assert.ok(typeof secondBytes === 'string');
    assert.deepEqual(
      Buffer.concat([Buffer.from(firstBytes, 'base64'), Buffer.from(secondBytes, 'base64')]),
      Buffer.from([255, 0, 128, 65]),
    );
  } finally {
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE process aliases resolve to explicit executables and are exposed in schemas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-alias-'));
  const registration = createProcessTools({
    root,
    commands: {
      'node-wrapper': {
        command: process.execPath,
        args: [
          '-e',
          'process.exit(process.argv[1] === "fixed" && process.argv[2] === "model" ? 0 : 9)',
          'fixed',
        ],
      },
    },
    environment: { SAFE_VALUE: 'configured' },
  });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    const schema = registration.toolSchemas.swe_exec;
    assert.ok(isJsonObject(schema));
    assert.ok(isJsonObject(schema.properties));
    assert.ok(isJsonObject(schema.properties.command));
    assert.match(String(schema.properties.command.description), /node-wrapper/);
    const result = await dispatch(created.value, 'swe_exec', {
      command: 'node-wrapper',
      args: ['model'],
    });
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
  } finally {
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE process finalizes terminal state and aborts an artifact writer after finalize failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-artifact-finalize-'));
  let aborted = 0;
  const artifacts = {
    async create() {
      return ok({
        async write() {
          return ok(undefined);
        },
        async finalize() {
          return fail('artifact.finalize', 'test finalize failure', 'unavailable');
        },
        async abort() {
          aborted += 1;
          return ok(undefined);
        },
      });
    },
    async read() {
      return fail('artifact.test', 'not used', 'unavailable');
    },
  };
  const registration = createProcessTools({ root, artifacts });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    const started = await dispatch(created.value, 'swe_process_start', {
      command: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
    });
    assert.ok(typeof started.processId === 'string');
    const status = await dispatch(created.value, 'swe_process_wait', {
      processId: started.processId,
    });
    assert.equal(status.status, 'exited');
    assert.equal(status.artifactError, 'part.artifact.finalize');
    assert.equal(aborted, 1);
  } finally {
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE process remains terminal when the artifact adapter throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-artifact-throw-'));
  const artifacts = {
    async create() {
      throw new Error('test adapter throw');
    },
    async read() {
      return fail('artifact.test', 'not used', 'unavailable');
    },
  };
  const registration = createProcessTools({ root, artifacts });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    const started = await dispatch(created.value, 'swe_process_start', {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    });
    assert.ok(typeof started.processId === 'string');
    const status = await dispatch(created.value, 'swe_process_wait', {
      processId: started.processId,
    });
    assert.equal(status.status, 'exited');
    assert.equal(status.artifactError, 'part.swe.process-artifact');
  } finally {
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE process close reports unresolved cancelled process trees and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-cleanup-report-'));
  const registration = createProcessTools({ root });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  const kill = process.kill;
  try {
    process.kill = (pid, signal) => {
      if (pid < 0) return true;
      return kill(pid, signal);
    };
    const started = await dispatch(created.value, 'swe_process_start', {
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},200)'],
    });
    assert.ok(typeof started.processId === 'string');
    await pause(100);
    await dispatch(created.value, 'swe_process_cancel', { processId: started.processId });
    const first = await registration.close();
    const second = await registration.close();
    assert.deepEqual(second, first);
    assert.equal(first.unresolved.length, 1);
    assert.equal(first.errors[0]?.code, 'part.scripts.process-tree');
  } finally {
    process.kill = kill;
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SWE process tools reject unsafe launch input and require shell opt-in', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-swe-validation-'));
  const registration = createProcessTools({ root });
  const created = createToolDispatcher({ tools: registration.tools });
  assert.equal(created.ok, true);
  try {
    for (const args of [
      { command: 'node', args: [] },
      { command: process.execPath, args: ['ok\0bad'] },
      { command: process.execPath, shell: true },
    ]) {
      const result = await created.value.dispatch(
        { logicalCallId: crypto.randomUUID(), toolId: 'swe_process_start', arguments: args },
        localContext(),
      );
      assert.equal(result.ok, false);
    }
  } finally {
    await registration.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['cancel', 'timeout']) {
  test(`SWE process ${mode} terminates descendants`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'part-swe-tree-'));
    const ready = join(root, 'ready');
    const registration = createProcessTools({ root });
    const created = createToolDispatcher({ tools: registration.tools });
    assert.equal(created.ok, true);
    let descendant;
    try {
      const childSource = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
      const parentSource = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore',detached:${process.platform === 'win32'}});c.unref();setInterval(()=>{},1000)`;
      const started = await dispatch(created.value, 'swe_process_start', {
        command: process.execPath,
        args: ['-e', parentSource],
        ...(mode === 'timeout' ? { timeoutMs: 100 } : {}),
      });
      const processId = started.processId;
      assert.ok(typeof processId === 'string');
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          descendant = Number(await readFile(ready, 'utf8'));
          break;
        } catch {
          await pause(10);
        }
      }
      assert.ok(descendant);
      if (mode === 'cancel') await dispatch(created.value, 'swe_process_cancel', { processId });
      const status = await waitFor(created.value, processId);
      assert.equal(status.status, mode === 'cancel' ? 'cancelled' : 'timed_out');
      await expectStopped(descendant);
    } finally {
      await registration.close();
      if (descendant) {
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
