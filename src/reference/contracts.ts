/**
 * part — progressive agent runtime, contract reference 0.2 (2026-10-14).
 * Declaration-only DESIGN, not an implemented/published library.
 * The self-contained specification embeds this entire file.
 * TypeScript is reference notation; package layout and implementation language remain ADRs.
 * Optional namespaces are separate logical exports, NOT compulsory core dependencies.
 * Static type checks do not establish behavioral conformance or recovery guarantees.
 */

export namespace Contracts {
  export type Json =
    null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
  export type QualifiedId = string;
  export type EntityId = string;
  export type Revision = string;
  export type Cursor = string;
  export type Timestamp = string;
  export type Digest = string;
  export type ScopeKind =
    | 'application'
    | 'runtime'
    | 'session'
    | 'run'
    | 'operation'
    | 'request'
    | 'client'
    | 'surface'
    | (string & {});
  export interface SchemaRef {
    readonly id: QualifiedId;
    readonly version: number;
  }
  export interface EntityRef {
    readonly owner: QualifiedId;
    readonly kind: QualifiedId;
    readonly id: EntityId;
  }
  /** Optional generic data handle. No document/backlog/proposal semantics. */
  export interface DataRef extends EntityRef {
    readonly version?: Revision;
  }
  export interface ArtifactRef {
    readonly store: QualifiedId;
    readonly id: EntityId;
  }
  export interface ResourceRef {
    readonly owner: QualifiedId;
    readonly id: EntityId;
    readonly kind: QualifiedId;
  }
  export interface Versioned<T> {
    readonly value: T;
    readonly revision: Revision;
  }
  export interface Page<T> {
    readonly items: readonly T[];
    readonly nextCursor?: Cursor;
  }
  export interface Issue {
    readonly path: readonly (string | number)[];
    readonly code: string;
    readonly message: string;
  }
  export type EffectState =
    | 'not-applicable'
    | 'not-attempted'
    | 'not-applied'
    | 'applied'
    | 'partially-applied'
    | 'unknown';
  export interface Failure {
    readonly code: QualifiedId;
    readonly category:
      | 'validation'
      | 'unsupported'
      | 'conflict'
      | 'permission'
      | 'unavailable'
      | 'timeout'
      | 'cancelled'
      | 'internal';
    readonly message: string;
    readonly retry: 'never' | 'safe-read' | 'after-reconciliation' | 'unspecified';
    readonly effect?: EffectState;
    readonly operationId?: EntityId;
    readonly retryAfterMs?: number;
    readonly details?: Json;
  }
  export type Result<T, E = Failure> =
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
  export interface Codec<T> {
    readonly schema: SchemaRef;
    encode(value: T): Result<Json>;
    decode(value: Json): Result<T>;
  }
  export interface Schema<T> {
    readonly ref: SchemaRef;
    validate(input: unknown): Result<T, readonly Issue[]>;
    readonly codec?: Codec<T>;
  }
  export interface JsonSchemaExporter {
    exportSchema<T>(
      schema: Schema<T>,
      target: string,
    ): Result<{ readonly schema: Json; readonly losses: readonly string[] }>;
  }
  export interface Provenance {
    readonly component: QualifiedId;
    readonly componentVersion: string;
    readonly origin: 'user' | 'agent' | 'driver' | 'policy' | 'module' | 'external' | 'import';
    readonly causationId?: EntityId;
    readonly correlationId?: EntityId;
    readonly source?: string;
  }
  export interface ScopeRef {
    readonly kind: ScopeKind;
    readonly id: EntityId;
  }
  export interface Capability {
    readonly id: QualifiedId;
    readonly contractVersion: number;
    readonly status: 'supported' | 'unsupported' | 'conditional';
    readonly implementedBy: QualifiedId;
    readonly constraints: Json;
  }
  export interface CapabilitySet {
    readonly revision: Revision;
    readonly entries: readonly Capability[];
  }
  export interface ServiceKey<T> {
    readonly id: QualifiedId;
    readonly contractVersion: number;
    readonly scope: ScopeKind;
    readonly typeWitness?: (value: T) => T;
  }
  export interface ServiceAccess {
    get<T>(key: ServiceKey<T>): Result<T>;
  }
  /** Process-local. Constructed by a trusted embedding/host adapter; NEVER accepted from wire payload. */
  export interface InvocationContext {
    readonly principal: { readonly subject: string; readonly authority: QualifiedId };
    readonly scope: ScopeRef;
    readonly services: ServiceAccess;
    readonly signal: AbortSignal;
    readonly deadline?: Timestamp;
    readonly correlationId: EntityId;
    readonly causationId?: EntityId;
    readonly idempotencyKey?: string;
  }
  export interface Preconditions {
    readonly versions: readonly { readonly ref: EntityRef; readonly expected: Revision }[];
  }
  export interface CommandRequest<I = Json> {
    readonly protocolVersion: number;
    readonly commandId: EntityId;
    readonly actionId: QualifiedId;
    readonly actionVersion: number;
    readonly target?: EntityRef;
    readonly input: I;
    readonly preconditions?: Preconditions;
    readonly idempotencyKey?: string;
  }
  export interface CommitEvidence {
    readonly owner: QualifiedId;
    readonly revision: Revision;
    readonly durability: 'memory' | 'durable';
    readonly transactionId?: EntityId;
  }
  export type CommandReceipt<O = Json> =
    | {
        readonly kind: 'completed';
        readonly commandId: EntityId;
        readonly result: O;
        readonly commit: readonly CommitEvidence[];
        readonly effect: EffectState;
      }
    | {
        readonly kind: 'accepted';
        readonly commandId: EntityId;
        readonly operation: EntityRef;
        readonly commit: readonly CommitEvidence[];
      }
    | { readonly kind: 'rejected'; readonly commandId: EntityId; readonly error: Failure }
    | {
        readonly kind: 'failed';
        readonly commandId: EntityId;
        readonly error: Failure;
        readonly effect: EffectState;
        readonly commit: readonly CommitEvidence[];
        readonly operation?: EntityRef;
      };
  export interface ActionDescriptor {
    readonly id: QualifiedId;
    readonly version: number;
    readonly input: SchemaRef;
    readonly output: SchemaRef;
    readonly targetKind?: QualifiedId;
    readonly execution: 'immediate' | 'operation';
    readonly availability: {
      readonly state: 'available' | 'disabled';
      readonly reason?: string;
      readonly checkedAt: Revision;
    };
    readonly presentation?: Json;
  }
  export interface QueryRequest<I = Json> {
    readonly queryId: QualifiedId;
    readonly version: number;
    readonly input: I;
    readonly target?: EntityRef;
  }
  export interface CleanupReport {
    readonly released: readonly EntityRef[];
    readonly unresolved: readonly EntityRef[];
    readonly errors: readonly Failure[];
  }
}
