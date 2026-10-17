import { fail } from '@slop-lab/part/contracts/index.js';
import type { Contracts } from '@slop-lab/part/reference/index.js';
import { rm } from 'node:fs/promises';
import type { ProcessRecord } from './process-types.js';

export async function closeProcessRecords(
  records: ReadonlyMap<string, ProcessRecord>,
): Promise<Contracts.CleanupReport> {
  for (const record of records.values())
    if (record.state === 'running') {
      record.termination = 'cancelled';
      record.controller.abort('closed');
    }
  await Promise.all([...records.values()].map((record) => record.done));
  const released: Contracts.EntityRef[] = [];
  const unresolved: Contracts.EntityRef[] = [];
  const errors: Contracts.Failure[] = [];
  for (const record of records.values()) {
    const ref = {
      owner: 'part/swe-process',
      kind: record.unresolvedPid ? 'process-tree' : 'process',
      id: String(record.unresolvedPid ?? record.id),
    };
    if (record.unresolvedPid) unresolved.push(ref);
    else released.push(ref);
    if (record.cleanupError) errors.push(record.cleanupError);
    try {
      await rm(record.directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(
        fail(
          'swe.process-cleanup',
          error instanceof Error ? error.message : 'Process output cleanup failed',
          'unavailable',
        ).error,
      );
    }
  }
  return { released, unresolved, errors };
}
