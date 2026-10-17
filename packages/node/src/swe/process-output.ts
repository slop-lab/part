import type { Contracts, Storage, Tools } from '@slop-lab/part/reference/index.js';
import { readFile } from 'node:fs/promises';
import type { ProcessRecord, ReadInput } from './process-types.js';

export function processStatus(record: ProcessRecord): Contracts.Json {
  return {
    processId: record.id,
    owner: 'toolset',
    status: record.state,
    success: record.state === 'running' ? null : record.state === 'exited' && record.exitCode === 0,
    exitCode: record.exitCode,
    signal: record.signal,
    truncated: record.truncated,
    ...(record.artifact
      ? { artifact: { store: record.artifact.store, id: record.artifact.id } }
      : {}),
    ...(record.artifactError ? { artifactError: record.artifactError } : {}),
  };
}

export async function publishProcessArtifact(
  record: ProcessRecord,
  artifacts: Storage.ArtifactStore | undefined,
  context: Tools.ExecutionContext,
): Promise<void> {
  if (!artifacts) return;
  let writer: Storage.ArtifactWriter | undefined;
  try {
    const [stdout, stderr] = await Promise.all([
      readFile(record.stdoutPath),
      readFile(record.stderrPath),
    ]);
    const bytes = Buffer.concat([stdout, Buffer.from('\n--- stderr ---\n'), stderr]);
    const created = await artifacts.create(
      {
        mediaType: 'application/octet-stream',
        name: `process-${record.id}.log`,
        provenance: { component: 'part/swe-process', componentVersion: '1', origin: 'module' },
      },
      context,
    );
    if (!created.ok) {
      record.artifactError = created.error.code;
      return;
    }
    writer = created.value;
    const written = await writer.write(bytes);
    if (!written.ok) {
      record.artifactError = written.error.code;
      await writer.abort();
      return;
    }
    const finalized = await writer.finalize();
    if (finalized.ok) record.artifact = finalized.value.ref;
    else {
      record.artifactError = finalized.error.code;
      await writer.abort();
    }
  } catch {
    record.artifactError = 'part.swe.process-artifact';
    if (writer)
      try {
        await writer.abort();
      } catch {
        record.artifactError = 'part.swe.process-artifact-abort';
      }
  }
}

export async function readProcessOutput(
  record: ProcessRecord,
  input: ReadInput,
  maxInlineBytes: number,
): Promise<Contracts.Json> {
  const bytes = await readFile(input.stream === 'stderr' ? record.stderrPath : record.stdoutPath);
  const offset = input.offset ?? 0;
  const selected = bytes.subarray(
    offset,
    offset + Math.min(input.limit ?? maxInlineBytes, maxInlineBytes),
  );
  return {
    processId: record.id,
    stream: input.stream ?? 'stdout',
    encoding: 'base64',
    offset,
    bytes: selected.toString('base64'),
    nextOffset: offset + selected.length,
    eof: offset + selected.length >= bytes.length && record.state !== 'running',
  };
}
