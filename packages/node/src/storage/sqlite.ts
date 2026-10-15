import { fail, isJson, ok } from '@part/core/contracts';
import type { Contracts } from '@part/core/reference';
import type { LocalStore, StoreData } from '@part/core/storage/memory';
import { initialStoreData, storeFacade } from '@part/core/storage/memory';
import { DatabaseSync } from 'node:sqlite';
/** Explicitly opens a single local database. No resource is created on import. */
export function openSqliteStore(path: string, id = 'part/sqlite'): Contracts.Result<LocalStore> {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
    database.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS part_store (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
  } catch {
    return fail('storage.open', 'Could not open SQLite store', 'unavailable');
  }
  let closed = false;
  return ok(
    storeFacade(
      id,
      'durable',
      (write, action) => {
        if (closed) return fail('storage.closed', 'Store is closed', 'conflict');
        try {
          database.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
          const row = database.prepare('SELECT data FROM part_store WHERE id = ?').get(id);
          const data: StoreData = row ? JSON.parse(String(row.data)) : initialStoreData();
          if (
            !isJson(data) ||
            !Number.isSafeInteger(data.revision) ||
            !Array.isArray(data.journal) ||
            !data.state ||
            !data.changes ||
            !data.commands
          )
            throw new Error('Corrupt store');
          const result = action(data);
          if (!result.ok) {
            database.exec('ROLLBACK');
            return result;
          }
          if (write)
            database
              .prepare(
                'INSERT INTO part_store(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
              )
              .run(id, JSON.stringify(result.value.data));
          database.exec('COMMIT');
          return ok(result.value.value);
        } catch {
          try {
            database.exec('ROLLBACK');
          } catch {}
          return fail('storage.transaction', 'SQLite transaction failed', 'unavailable');
        }
      },
      () => {
        if (!closed) {
          closed = true;
          database.close();
        }
      },
    ),
  );
}
