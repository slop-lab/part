import type { Contracts } from './contracts.js';
export namespace Storage {
  export interface Capabilities {
    readonly history: 'memory' | 'durable';
    readonly atomicStateJournal: boolean;
    readonly commandDedupe?: { readonly scope: string; readonly retentionMs: number };
    readonly eventReplay?: { readonly retentionMs: number };
    readonly durableWaits: boolean;
    readonly resumableHandlers: readonly string[];
    readonly artifactFinalization: boolean;
  }
  export interface StateAddress {
    readonly namespace: string;
    readonly scope: Contracts.ScopeRef;
    readonly key: string;
  }
  export interface StateValue {
    readonly schemaVersion: number;
    readonly value: Contracts.Json;
  }
  export interface Mutation {
    readonly address: StateAddress;
    readonly expected: string | 'absent';
    readonly next: StateValue | null;
  }
  export interface JournalEntry {
    readonly id: string;
    readonly type: string;
    readonly version: number;
    readonly payload: Contracts.Json;
    readonly provenance: Contracts.Provenance;
  }
  export interface ChangeSet {
    readonly id: string;
    readonly mutations: readonly Mutation[];
    readonly append: readonly JournalEntry[];
    readonly commandReceipt?: {
      readonly key: string;
      readonly requestDigest: string;
      readonly receipt: Contracts.Json;
    };
  }
  export interface CommitReceipt extends Contracts.CommitEvidence {
    readonly appended: readonly string[];
    readonly publicationWatermark?: string;
  }
  export interface StateJournalStore {
    readonly id: string;
    readonly capabilities: Capabilities;
    read(
      address: StateAddress,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Versioned<StateValue> | null>>;
    commit(
      changes: ChangeSet,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<CommitReceipt>>;
    journal(
      cursor: string | undefined,
      limit: number,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Page<JournalEntry>>>;
  }
  export interface Migration {
    readonly namespace: string;
    readonly from: number;
    readonly to: number;
    transform(value: Contracts.Json): Contracts.Result<Contracts.Json>;
  }
  export interface ArtifactMetadata {
    readonly mediaType: string;
    readonly name?: string;
    readonly provenance: Contracts.Provenance;
  }
  export interface FinalizedArtifact {
    readonly ref: Contracts.ArtifactRef;
    readonly bytes: number;
    readonly digest: string;
    readonly durability: 'memory' | 'durable';
  }
  export interface ArtifactWriter {
    write(chunk: Uint8Array): Promise<Contracts.Result<void>>;
    finalize(): Promise<Contracts.Result<FinalizedArtifact>>;
    abort(): Promise<Contracts.Result<void>>;
  }
  export interface ArtifactStore {
    create(
      metadata: ArtifactMetadata,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<ArtifactWriter>>;
    read(
      ref: Contracts.ArtifactRef,
      range: { readonly start: number; readonly length: number } | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<AsyncIterable<Uint8Array>>>;
  }
  export interface RecoveryReport {
    readonly recovered: readonly Contracts.EntityRef[];
    readonly abandoned: readonly Contracts.EntityRef[];
    readonly reconciliationRequired: readonly Contracts.EntityRef[];
    readonly errors: readonly Contracts.Failure[];
  }
  export interface RecoveryAdapter {
    recover(context: Contracts.InvocationContext): Promise<Contracts.Result<RecoveryReport>>;
  }
}
