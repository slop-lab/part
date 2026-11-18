import { createHash } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
import { isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { ChatGPTAccountStore } from './accounts.js';
import type { ChatGPTRegistration } from './oauth.js';

function readRegistration(raw: string): ChatGPTRegistration {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid stored ChatGPT registration');
  }
  if (
    !isJsonObject(value) ||
    typeof value.hostId !== 'string' ||
    !isJsonObject(value.identity) ||
    typeof value.identity.issuer !== 'string' ||
    typeof value.identity.clientId !== 'string' ||
    typeof value.identity.subject !== 'string' ||
    typeof value.identity.emailVerified !== 'boolean'
  )
    throw new Error('Invalid stored ChatGPT registration');
  return value as unknown as ChatGPTRegistration;
}

/**
 * Durable ChatGPT account storage for Node hosts on a local filesystem. Each owner
 * has an independent SQLite lock, including across processes sharing the directory.
 */
export function createSqliteChatGPTAccountStore(directory: string): ChatGPTAccountStore {
  const root = resolve(directory);
  return {
    async withAccount(owner, run) {
      if (!owner.trim()) throw new Error('An application user ID is required');
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32' && ((await stat(root)).mode & 0o077) !== 0)
        throw new Error('ChatGPT account storage requires a private directory');
      const path = join(root, `${createHash('sha256').update(owner).digest('hex')}.sqlite`);
      const file = await open(path, 'a', 0o600);
      await file.close();
      if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0)
        throw new Error('ChatGPT account storage requires private database files');
      const database = new DatabaseSync(path);
      try {
        // In exclusive locking mode COMMIT writes the record durably and the lock
        // is held until close, so OAuth refresh never races another store client.
        database.exec('PRAGMA locking_mode=EXCLUSIVE;');
        const deadline = performance.now() + 60_000;
        for (;;) {
          try {
            database.exec('BEGIN EXCLUSIVE; COMMIT;');
            break;
          } catch (error) {
            const busy =
              error instanceof Error &&
              'errcode' in error &&
              typeof error.errcode === 'number' &&
              (error.errcode & 255) === 5;
            if (!busy) throw error;
            if (performance.now() >= deadline) throw new Error('ChatGPT account store is busy');
            await setTimeout(25);
          }
        }
        database.exec(
          'PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS account (slot INTEGER PRIMARY KEY, registration TEXT NOT NULL);',
        );
        const raw = database
          .prepare('SELECT registration FROM account WHERE slot = 1')
          .get()?.registration;
        const account = typeof raw === 'string' ? readRegistration(raw) : undefined;
        return await run(account, async (next) => {
          if (next)
            database
              .prepare(
                'INSERT INTO account (slot, registration) VALUES (1, ?) ON CONFLICT(slot) DO UPDATE SET registration = excluded.registration',
              )
              .run(JSON.stringify(next));
          else database.exec('DELETE FROM account WHERE slot = 1');
        });
      } finally {
        database.close();
      }
    },
  };
}
