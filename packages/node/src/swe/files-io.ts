import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, rename, unlink, writeFile } from 'node:fs/promises';

const activeMutations = new Map<string, Promise<void>>();
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class BoundedFileError extends Error {
  constructor(readonly kind: 'too-large' | 'binary') {
    super(kind);
    this.name = 'BoundedFileError';
  }
}

export async function readUtf8Bounded(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new BoundedFileError('too-large');
    try {
      return utf8.decode(Buffer.concat(chunks, total));
    } catch (error) {
      if (error instanceof TypeError) throw new BoundedFileError('binary');
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function withPathMutation<T>(path: string, mutate: () => Promise<T>): Promise<T> {
  const previous = activeMutations.get(path) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeMutations.set(path, current);
  await previous;
  try {
    return await mutate();
  } finally {
    release?.();
    if (activeMutations.get(path) === current) activeMutations.delete(path);
  }
}

export async function atomicWrite(
  path: string,
  content: string,
  preserveMode: boolean,
): Promise<void> {
  const temporary = `${path}.part-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    if (preserveMode) await chmod(temporary, (await lstat(path)).mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!(
        cleanupError instanceof Error &&
        'code' in cleanupError &&
        cleanupError.code === 'ENOENT'
      ))
        throw cleanupError;
    });
    throw error;
  }
}
