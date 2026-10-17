// @ts-check
import { createWorkspaceTools } from '@slop-lab/part-node/swe/workspace.js';
import {
  isWorkspaceFileResult,
  isWorkspaceListResult,
  isWorkspaceReadResult,
  isWorkspaceSearchResult,
} from '@slop-lab/part-node/swe/workspace-results.js';
import { localContext } from '@slop-lab/part/contracts/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { present } from '../fixtures/assertions.mjs';

const context = localContext();

/** @template T @param {import('@slop-lab/part/reference/index.js').Tools.Dispatcher} dispatcher @param {string} toolId @param {unknown} arguments_ @param {(value: unknown) => value is T} guard @returns {Promise<T>} */
async function call(dispatcher, toolId, arguments_, guard) {
  const started = await dispatcher.dispatch(
    { logicalCallId: crypto.randomUUID(), toolId, arguments: arguments_ },
    context,
  );
  assert.equal(started.ok, true);
  const outcome = await started.value.done;
  assert.equal(outcome.phase, 'completed');
  const value = outcome.result.value;
  if (!guard(value)) throw new TypeError(`Invalid ${toolId} result`);
  return value;
}

/** @param {import('@slop-lab/part/reference/index.js').Tools.Dispatcher} dispatcher @param {string} toolId @param {unknown} arguments_ */
async function callFailure(dispatcher, toolId, arguments_) {
  const started = await dispatcher.dispatch(
    { logicalCallId: crypto.randomUUID(), toolId, arguments: arguments_ },
    context,
  );
  assert.equal(started.ok, true);
  const outcome = await started.value.done;
  if (outcome.phase !== 'failed') throw new TypeError(`Expected ${toolId} failure`);
  return outcome.error;
}

test('workspace tools read, list and search bounded local files with provenance', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'one.txt'), 'alpha\nbeta\nalpha\n');
    const registration = createWorkspaceTools({ root, maxOutputChars: 80 });
    const dispatcher = assertDispatcher(registration.tools);

    // When
    const read = await call(dispatcher, 'swe_read', { path: 'src/one.txt' }, isWorkspaceReadResult);
    const listed = await call(dispatcher, 'swe_list', { path: 'src' }, isWorkspaceListResult);
    const searched = await call(
      dispatcher,
      'swe_search',
      { path: '.', query: 'alpha' },
      isWorkspaceSearchResult,
    );

    // Then
    const firstLine = present(read.lines[0]);
    assert.equal(read.content, 'alpha\nbeta\nalpha\n');
    assert.match(read.digest, /^[a-f0-9]{64}$/);
    assert.equal(firstLine.line, 1);
    assert.match(firstLine.hash, /^[a-f0-9]{8}$/);
    assert.deepEqual(
      listed.entries.map((entry) => entry.path),
      ['src/one.txt'],
    );
    assert.deepEqual(
      searched.matches.map((match) => match.line),
      [1, 3],
    );
    assert.equal(read.provenance.path, 'src/one.txt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hash edits reject stale line addresses atomically', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  try {
    await writeFile(join(root, 'file.txt'), 'same\nkeep\nsame\n');
    const dispatcher = assertDispatcher(createWorkspaceTools({ root }).tools);
    const original = await call(
      dispatcher,
      'swe_read',
      { path: 'file.txt' },
      isWorkspaceReadResult,
    );
    const firstLine = present(original.lines[0]);
    const thirdLine = present(original.lines[2]);

    // When
    const edited = await call(
      dispatcher,
      'swe_edit',
      {
        path: 'file.txt',
        expectedDigest: original.digest,
        edits: [{ line: 3, hash: thirdLine.hash, newText: 'changed' }],
      },
      isWorkspaceFileResult,
    );

    // Then
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'same\nkeep\nchanged\n');
    assert.notEqual(edited.digest, original.digest);
    const stale = await callFailure(dispatcher, 'swe_edit', {
      path: 'file.txt',
      expectedDigest: original.digest,
      edits: [{ line: 1, hash: firstLine.hash, newText: 'bad' }],
    });
    assert.equal(stale.code, 'part.workspace.stale');
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'same\nkeep\nchanged\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact edits and whole-file writes enforce preconditions', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  try {
    await writeFile(join(root, 'file.txt'), 'before unique after');
    const dispatcher = assertDispatcher(createWorkspaceTools({ root, editMode: 'exact' }).tools);
    const original = await call(
      dispatcher,
      'swe_read',
      { path: 'file.txt' },
      isWorkspaceReadResult,
    );

    // When
    await call(
      dispatcher,
      'swe_edit',
      {
        path: 'file.txt',
        expectedDigest: original.digest,
        oldText: 'unique',
        newText: 'updated',
      },
      isWorkspaceFileResult,
    );
    await call(
      dispatcher,
      'swe_write',
      { path: 'new.txt', absent: true, content: 'new' },
      isWorkspaceFileResult,
    );

    // Then
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'before updated after');
    await assert.rejects(
      call(
        dispatcher,
        'swe_write',
        { path: 'new.txt', absent: true, content: 'x' },
        isWorkspaceFileResult,
      ),
    );
    await assert.rejects(
      call(dispatcher, 'swe_write', { path: 'unsafe.txt', content: 'x' }, isWorkspaceFileResult),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace tools reject traversal and symlink escapes', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  const outside = await mkdtemp(join(tmpdir(), 'part-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escape'), 'dir');
    await symlink(join(outside, 'secret.txt'), join(root, 'leaf.txt'), 'file');
    const dispatcher = assertDispatcher(createWorkspaceTools({ root }).tools);

    // When / Then
    await assert.rejects(
      call(dispatcher, 'swe_read', { path: '../secret.txt' }, isWorkspaceReadResult),
    );
    await assert.rejects(
      call(dispatcher, 'swe_read', { path: 'escape/secret.txt' }, isWorkspaceReadResult),
    );
    await assert.rejects(
      call(
        dispatcher,
        'swe_write',
        { path: 'escape/new.txt', absent: true, content: 'bad' },
        isWorkspaceFileResult,
      ),
    );
    const leaf = await callFailure(dispatcher, 'swe_write', {
      path: 'leaf.txt',
      expectedDigest: createHash('sha256').update('secret').digest('hex'),
      content: 'bad',
    });
    assert.equal(leaf.code, 'part.workspace.symlink');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('exact and hash edits preserve content beyond bounded read output', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  try {
    await writeFile(join(root, 'exact.txt'), 'prefix TARGET suffix');
    await writeFile(join(root, 'hash.txt'), 'one\ntwo\nthree\n');
    const exact = assertDispatcher(
      createWorkspaceTools({ root, editMode: 'exact', maxOutputChars: 8 }).tools,
    );
    const hash = assertDispatcher(createWorkspaceTools({ root, maxOutputChars: 8 }).tools);
    const exactRead = await call(exact, 'swe_read', { path: 'exact.txt' }, isWorkspaceReadResult);
    const hashRead = await call(hash, 'swe_read', { path: 'hash.txt' }, isWorkspaceReadResult);
    const firstLine = present(hashRead.lines[0]);

    // When
    await call(
      exact,
      'swe_edit',
      {
        path: 'exact.txt',
        expectedDigest: exactRead.digest,
        oldText: 'TARGET',
        newText: 'updated',
      },
      isWorkspaceFileResult,
    );
    await call(
      hash,
      'swe_edit',
      {
        path: 'hash.txt',
        expectedDigest: hashRead.digest,
        edits: [{ line: 1, hash: firstLine.hash, newText: 'ONE' }],
      },
      isWorkspaceFileResult,
    );

    // Then
    assert.equal(await readFile(join(root, 'exact.txt'), 'utf8'), 'prefix updated suffix');
    assert.equal(await readFile(join(root, 'hash.txt'), 'utf8'), 'ONE\ntwo\nthree\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace reads reject oversized and non-UTF-8 files without changing their bytes', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  try {
    await writeFile(join(root, 'large.txt'), Buffer.alloc(2_000_000, 97));
    const binary = Buffer.from([0x66, 0x80, 0x6f]);
    await writeFile(join(root, 'binary.txt'), binary);
    const dispatcher = assertDispatcher(
      createWorkspaceTools({ root, maxFileBytes: 16, editMode: 'exact' }).tools,
    );

    // When
    const oversized = await callFailure(dispatcher, 'swe_read', { path: 'large.txt' });
    const invalid = await callFailure(dispatcher, 'swe_read', { path: 'binary.txt' });

    // Then
    assert.equal(oversized.code, 'part.workspace.too-large');
    assert.equal(invalid.code, 'part.workspace.binary');
    assert.deepEqual(await readFile(join(root, 'binary.txt')), binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent writes from separate toolsets serialize the digest precondition', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
  try {
    await writeFile(join(root, 'file.txt'), 'original');
    const first = assertDispatcher(createWorkspaceTools({ root }).tools);
    const second = assertDispatcher(createWorkspaceTools({ root }).tools);
    const original = await call(first, 'swe_read', { path: 'file.txt' }, isWorkspaceReadResult);

    // When
    const outcomes = await Promise.allSettled([
      call(
        first,
        'swe_write',
        { path: 'file.txt', expectedDigest: original.digest, content: 'first' },
        isWorkspaceFileResult,
      ),
      call(
        second,
        'swe_write',
        { path: 'file.txt', expectedDigest: original.digest, content: 'second' },
        isWorkspaceFileResult,
      ),
    ]);

    // Then
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'replacing a file preserves its executable mode on POSIX',
  { skip: process.platform === 'win32' },
  async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), 'part-swe-'));
    try {
      const path = join(root, 'script.sh');
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o751);
      const dispatcher = assertDispatcher(createWorkspaceTools({ root }).tools);
      const original = await call(
        dispatcher,
        'swe_read',
        { path: 'script.sh' },
        isWorkspaceReadResult,
      );

      // When
      await call(
        dispatcher,
        'swe_write',
        { path: 'script.sh', expectedDigest: original.digest, content: '#!/bin/sh\nexit 1\n' },
        isWorkspaceFileResult,
      );

      // Then
      assert.equal((await stat(path)).mode & 0o777, 0o751);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('creating tools for an invalid root does not reject before a tool is called', async () => {
  // Given
  const missing = join(tmpdir(), `part-missing-${crypto.randomUUID()}`);
  /** @type {unknown[]} */
  const unhandled = [];
  /** @param {unknown} error */
  const capture = (error) => unhandled.push(error);
  process.once('unhandledRejection', capture);
  try {
    // When
    createWorkspaceTools({ root: missing });
    await new Promise((resolve) => setImmediate(resolve));

    // Then
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', capture);
  }
});

/** @param {readonly import('@slop-lab/part/reference/index.js').Tools.InstalledTool[]} tools */
function assertDispatcher(tools) {
  const created = createToolDispatcher({ tools });
  assert.equal(created.ok, true);
  return created.value;
}
