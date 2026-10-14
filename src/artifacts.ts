import type { Contracts as C, Storage as D } from './reference.js';
import { ok, fail, digest, canonical, freeze, isJson } from './contracts.js';

export interface ArtifactRecord {
  metadata: D.ArtifactMetadata;
  principal: C.InvocationContext['principal'];
  bytes: Uint8Array;
  digest: string;
}
export interface ArtifactBackend {
  readonly id: string;
  readonly durability: 'memory' | 'durable';
  save(id: string, record: ArtifactRecord): Promise<void>;
  load(id: string): Promise<ArtifactRecord | null>;
}
/** Finalization publishes immutable bytes. Metadata alone never grants access. */
export function createArtifactStore(
  backend: ArtifactBackend,
  maxBytes = 16 * 1024 * 1024,
): D.ArtifactStore {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Invalid artifact limit');
  return {
    async create(metadata, context) {
      if (!isJson(metadata) || !metadata.mediaType || context.signal.aborted)
        return fail('artifact.create', 'Invalid metadata or cancelled writer');
      const fixed = structuredClone(metadata),
        principal = { ...context.principal };
      const chunks: Uint8Array[] = [];
      let size = 0,
        state: 'open' | 'finalizing' | 'finalized' | 'aborted' = 'open';
      let finalized: D.FinalizedArtifact | undefined;
      const abort = () => {
        if (state === 'open') {
          state = 'aborted';
          chunks.length = 0;
        }
      };
      context.signal.addEventListener('abort', abort, { once: true });
      return ok({
        async write(chunk) {
          if (state !== 'open' || context.signal.aborted)
            return fail('artifact.closed', 'Writer is closed');
          if (!(chunk instanceof Uint8Array) || size + chunk.byteLength > maxBytes) {
            abort();
            context.signal.removeEventListener('abort', abort);
            return fail('artifact.size', 'Artifact exceeds byte limit');
          }
          chunks.push(chunk.slice());
          size += chunk.byteLength;
          return ok(undefined);
        },
        async finalize() {
          if (finalized) return ok(finalized);
          if (state !== 'open' || context.signal.aborted)
            return fail('artifact.closed', 'Writer is closed');
          state = 'finalizing';
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          chunks.length = 0;
          try {
            const hash = await digest(bytes),
              id = crypto.randomUUID();
            if (context.signal.aborted) {
              state = 'aborted';
              return fail('artifact.cancelled', 'Finalization cancelled', 'cancelled');
            }
            await backend.save(id, { metadata: fixed, principal, bytes, digest: hash });
            // Once committed, cancellation cannot turn a published object into a partial upload.
            finalized = freeze({
              ref: { store: backend.id, id },
              bytes: size,
              digest: hash,
              durability: backend.durability,
            });
            state = 'finalized';
            return ok(finalized);
          } catch {
            state = 'aborted';
            return fail('artifact.finalize', 'Artifact storage failed', 'unavailable');
          } finally {
            context.signal.removeEventListener('abort', abort);
          }
        },
        async abort() {
          if (state === 'finalizing' || state === 'finalized')
            return fail('artifact.finalizing', 'Finalization already started', 'conflict');
          abort();
          context.signal.removeEventListener('abort', abort);
          return ok(undefined);
        },
      });
    },
    async read(ref, range, context) {
      if (context.signal.aborted) return fail('artifact.cancelled', 'Read cancelled', 'cancelled');
      if (ref.store !== backend.id || !/^[0-9a-f-]{36}$/.test(ref.id))
        return fail('artifact.ref', 'Unknown artifact');
      try {
        const record = await backend.load(ref.id);
        if (!record) return fail('artifact.missing', 'Artifact not found');
        if (canonical(record.principal) !== canonical(context.principal))
          return fail('artifact.permission', 'Artifact access denied', 'permission');
        if (record.bytes.length > maxBytes || (await digest(record.bytes)) !== record.digest)
          return fail('artifact.integrity', 'Artifact integrity check failed');
        const start = range?.start ?? 0,
          length = range?.length ?? record.bytes.length;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(length) ||
          start < 0 ||
          length < 0 ||
          start + length > record.bytes.length
        )
          return fail('artifact.range', 'Range is outside the artifact');
        const bytes = record.bytes.slice(start, start + length);
        return ok(
          (async function* () {
            if (!context.signal.aborted) yield bytes;
          })(),
        );
      } catch {
        return fail('artifact.read', 'Artifact storage unavailable', 'unavailable');
      }
    },
  };
}
export function createMemoryArtifacts(
  options: { id?: string; maxBytes?: number } = {},
): D.ArtifactStore {
  const records = new Map<string, ArtifactRecord>();
  return createArtifactStore(
    {
      id: options.id ?? 'part/artifacts-memory',
      durability: 'memory',
      async save(id, record) {
        records.set(id, structuredClone(record));
      },
      async load(id) {
        const record = records.get(id);
        return record ? structuredClone(record) : null;
      },
    },
    options.maxBytes,
  );
}
