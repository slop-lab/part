import type { Composition } from './composition.js';
import type { Contracts } from './contracts.js';
export namespace Runtime {
  export type Phase =
    'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'abandoned';
  export interface Cancellation {
    readonly requestId?: Contracts.EntityId;
    readonly state: 'not-requested' | 'requested' | 'confirmed' | 'partial' | 'unsupported';
    readonly unresolvedTargets: readonly Contracts.EntityRef[];
  }
  export interface ExecutionSnapshot {
    readonly ref: Contracts.EntityRef;
    readonly revision: Contracts.Revision;
    readonly phase: Phase;
    readonly cancel: Cancellation;
    readonly effect: Contracts.EffectState;
    readonly parent?: Contracts.EntityRef;
    readonly nativeState?: Contracts.Json;
    readonly error?: Contracts.Failure;
  }
  export interface OutcomeEvidence {
    readonly effect: Contracts.EffectState;
    readonly unsettledChildren: readonly Contracts.EntityRef[];
    readonly commit: readonly Contracts.CommitEvidence[];
  }
  export type ManagedOutcome<T> = OutcomeEvidence &
    (
      | { readonly phase: 'completed'; readonly result: T }
      | { readonly phase: 'failed'; readonly error: Contracts.Failure }
      | { readonly phase: 'cancelled'; readonly error?: Contracts.Failure }
      | { readonly phase: 'abandoned'; readonly error: Contracts.Failure }
    );
  export type Update<T = Contracts.Json> =
    | { readonly kind: 'data'; readonly index: number; readonly type: string; readonly payload: T }
    | {
        readonly kind: 'gap';
        readonly from: number;
        readonly to: number;
        readonly recovery: 'snapshot' | 'final-result' | 'unavailable';
      };
  export interface ProgressSink {
    publish(
      type: string,
      payload: Contracts.Json,
    ): Contracts.Result<{ readonly accepted: boolean; readonly dropped: number }>;
  }
  export interface ExecutionHandle<T, U = Contracts.Json> {
    readonly ref: Contracts.EntityRef;
    readonly done: Promise<ManagedOutcome<T>>;
    snapshot(): ExecutionSnapshot;
    observe(options?: {
      readonly signal?: AbortSignal;
      readonly bufferSize?: number;
    }): AsyncIterable<Update<U>>;
    requestCancel(reason: string): Promise<Contracts.Result<Cancellation>>;
  }
  export interface ExecutionLimits {
    readonly maxModelInvocations?: number;
    readonly maxToolDispatches?: number;
    readonly maxExecutorAttempts?: number;
    readonly maxChildRuns?: number;
    readonly maxConcurrentOperations?: number;
    readonly maxKnownTokens?: number;
    readonly estimatedCostCeiling?: { readonly amount: string; readonly currency: string };
    readonly deadline?: Contracts.Timestamp;
  }
  export interface Usage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cost?: {
      readonly amount: string;
      readonly currency: string;
      readonly basis: 'estimate' | 'provider-reported';
    };
    readonly providerNative?: Contracts.Json;
  }
  export interface BudgetReservation {
    readonly id: Contracts.EntityId;
    readonly dimension: string;
    readonly quantity: number;
  }
  export interface BudgetPort {
    reserve(dimension: string, quantity: number): Contracts.Result<BudgetReservation>;
    settle(reservation: BudgetReservation, actual: number | undefined): Contracts.Result<void>;
  }
  export interface RunRequest<I> {
    readonly driver: Contracts.QualifiedId;
    readonly input: I;
    readonly composition: Composition.CompositionHandle;
    readonly limits?: ExecutionLimits;
    readonly history?: {
      readonly sessionId: string;
      readonly branchId: string;
      readonly expectedHead?: string;
    };
    readonly parent?: Contracts.EntityRef;
  }
  export interface RunService {
    start<I>(
      request: RunRequest<I>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<ExecutionHandle<unknown>>>;
    get(
      ref: Contracts.EntityRef,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<ExecutionSnapshot>>;
    cancel(
      ref: Contracts.EntityRef,
      reason: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Cancellation>>;
  }
  export interface OperationSpec {
    readonly kind: Contracts.QualifiedId;
    readonly parent?: Contracts.EntityRef;
    readonly retryOwner: Contracts.QualifiedId;
    readonly childPolicy: 'attached' | 'explicit-transfer';
  }
  export interface OperationService {
    begin<T>(
      spec: OperationSpec,
      body: (context: Contracts.InvocationContext) => Promise<ManagedOutcome<T>>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<ExecutionHandle<T>>>;
  }
  export interface EffectPlan {
    readonly operationId: Contracts.EntityId;
    readonly attemptId: Contracts.EntityId;
    readonly target: Contracts.QualifiedId;
    readonly executor: Contracts.QualifiedId;
    readonly inputDigest: Contracts.Digest;
    readonly scopeDigest: Contracts.Digest;
    readonly compositionRevision: Contracts.Revision;
    readonly classification: 'read' | 'write' | 'external' | 'unknown';
  }
  /** A local, single-use token issued at an awaited execution boundary; not a serialized credential. */
  export interface AttemptPermit {
    readonly attemptId: Contracts.EntityId;
    readonly planDigest: Contracts.Digest;
    readonly boundary: Contracts.QualifiedId;
  }
  export type AttemptOutcome<T> =
    | { readonly kind: 'returned'; readonly value: T; readonly effect: Contracts.EffectState }
    | {
        readonly kind: 'failed';
        readonly error: Contracts.Failure;
        readonly effect: Contracts.EffectState;
      }
    | {
        readonly kind: 'cancelled';
        readonly effect: Contracts.EffectState;
        readonly error?: Contracts.Failure;
      };
  export interface InvocationBoundary {
    prepare(
      plan: EffectPlan,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<AttemptPermit>>;
    settle<T>(
      permit: AttemptPermit,
      outcome: AttemptOutcome<T>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Contracts.CommitEvidence[]>>;
  }
  export interface WaitSpec<T> {
    readonly type: Contracts.QualifiedId;
    readonly responseSchema: Contracts.Schema<T>;
    readonly presentation: Contracts.Json;
    readonly bindingDigest: Contracts.Digest;
    readonly expiresAt?: Contracts.Timestamp;
    readonly resume?: {
      readonly handler: Contracts.QualifiedId;
      readonly version: number;
      readonly state: Contracts.Json;
    };
  }
  export interface WaitTicket {
    readonly id: Contracts.EntityId;
    readonly revision: Contracts.Revision;
    readonly type: Contracts.QualifiedId;
    readonly state: 'open' | 'resolved' | 'expired' | 'cancelled';
    readonly durability: 'memory' | 'durable';
  }
  export interface SuspensionPort {
    open<T>(
      spec: WaitSpec<T>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<WaitTicket>>;
    respond(
      ticket: WaitTicket,
      response: unknown,
      commandId: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<WaitTicket>>;
    wait<T>(
      ticket: WaitTicket,
      schema: Contracts.Schema<T>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<T>>;
  }
}
