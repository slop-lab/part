import { mkdir, open, rename, readFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Storage } from './reference.js';
import { createArtifactStore } from './artifacts.js';
import { isJsonObject } from './contracts.js';
/** A bounded reference backend. One fsynced atomic record owns metadata and bytes. */
export async function openFileArtifacts(
  root: string,
  options: { id?: string; maxBytes?: number } = {},
): Promise<Storage.ArtifactStore> {
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const maximum = options.maxBytes ?? 16 * 1024 * 1024;
  return createArtifactStore(
    {
      id: options.id ?? 'part/artifacts-file',
      durability: 'durable',
      async save(id, record) {
        const pending = join(root, `${id}.pending`),
          target = join(root, `${id}.json`);
        try {
          const file = await open(pending, 'wx', 0o600);
          try {
            await file.writeFile(
              JSON.stringify({ ...record, bytes: Buffer.from(record.bytes).toString('base64') }),
            );
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(pending, target);
          const directory = await open(root, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await rm(pending, { force: true });
        }
      },
      async load(id) {
        const path = join(root, `${id}.json`);
        try {
          if ((await stat(path)).size > Math.ceil((maximum * 4) / 3) + 65536)
            throw new Error('Artifact too large');
          const value = JSON.parse(await readFile(path, 'utf8'));
          if (
            !isJsonObject(value) ||
            !isJsonObject(value.principal) ||
            !isJsonObject(value.metadata) ||
            typeof value.bytes !== 'string' ||
            typeof value.digest !== 'string'
          )
            throw new Error('Invalid artifact');
          const bytes = Buffer.from(value.bytes, 'base64');
          if (bytes.toString('base64') !== value.bytes)
            throw new Error('Invalid artifact encoding');
          return { ...value, bytes } as unknown as import('./artifacts.js').ArtifactRecord;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      },
    },
    maximum,
  );
}
