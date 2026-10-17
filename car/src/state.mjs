// @ts-check
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isJsonObject } from '@slop-lab/part/contracts/index.js';

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    return true;
  }
}

/** @param {string} directory @param {string} root */
export async function acquireState(directory, root) {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(directory);
  if (process.platform !== 'win32' && metadata.mode & 0o077)
    throw new Error(
      'CAR state directory must be private (chmod 700); history and full traces are sensitive',
    );
  const path = join(directory, 'owner.lock');
  const lock = await open(path, 'wx', 0o600).catch(() => {
    throw new Error(
      'CAR state directory already has an owner; use recover-lock only after the old owner exits',
    );
  });
  const owner = {
    version: 1,
    pid: process.pid,
    root,
    nonce: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    await lock.writeFile(JSON.stringify(owner));
    await lock.sync();
  } catch (error) {
    await lock.close();
    await unlink(path);
    throw error;
  }
  return {
    /** @param {import('@slop-lab/part/reference/index.js').Contracts.CleanupReport} report */
    async release(report) {
      if (report.unresolved.length) {
        await lock.truncate(0);
        await lock.write(JSON.stringify({ ...owner, unresolved: report.unresolved }), 0, 'utf8');
        await lock.sync();
      }
      await lock.close();
      if (!report.unresolved.length) await unlink(path);
    },
  };
}

/** Explicit operator recovery. Never probes or calls DIM.
 * @param {string} directory */
export async function recoverStateLock(directory) {
  const recoveryPath = join(resolve(directory), 'recovery.lock');
  const recovery = await open(recoveryPath, 'wx', 0o600);
  try {
    const path = join(resolve(directory), 'owner.lock');
    /** @type {unknown} */
    const owner = JSON.parse(await readFile(path, 'utf8'));
    if (
      !isJsonObject(owner) ||
      owner.version !== 1 ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.nonce !== 'string'
    )
      throw new Error('Unrecognized lock metadata; inspect and reconcile it manually');
    if (alive(owner.pid)) throw new Error('CAR owner is still alive; refusing lock recovery');
    if (Array.isArray(owner.unresolved) && owner.unresolved.length)
      throw new Error(
        'Lock contains unresolved resources; reconcile them manually before removing it',
      );
    await unlink(path);
    return { recovered: true, ownerPid: owner.pid };
  } finally {
    await recovery.close();
    await unlink(recoveryPath);
  }
}
