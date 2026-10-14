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

export namespace Composition {
  export type Surface = 'local' | 'server' | 'client' | 'ui' | 'test';
  export interface Requirement {
    readonly id: Contracts.QualifiedId;
    readonly contractVersion: number;
    readonly optional: boolean;
  }
  export interface ComponentDescriptor {
    readonly id: Contracts.QualifiedId;
    readonly version: string;
    readonly surfaces: readonly Surface[];
    readonly scope: Contracts.ScopeKind;
    readonly requires: readonly Requirement[];
    readonly provides: readonly Contracts.Capability[];
    readonly configSchema?: Contracts.SchemaRef;
  }
  export interface ExtensionPoint<T> {
    readonly id: Contracts.QualifiedId;
    readonly contractVersion: number;
    readonly owner: Contracts.QualifiedId;
    readonly kind: 'service' | 'pipeline' | 'registry' | 'collection';
    readonly scope: Contracts.ScopeKind;
    readonly typeWitness?: (value: T) => T;
  }
  export interface Contribution<T> {
    readonly id: Contracts.QualifiedId;
    readonly point: ExtensionPoint<T>;
    readonly value: T;
    readonly key?: string;
    readonly before?: readonly Contracts.QualifiedId[];
    readonly after?: readonly Contracts.QualifiedId[];
  }
  export interface Replacement<T> {
    readonly point: ExtensionPoint<T>;
    readonly replaces: Contracts.QualifiedId;
    readonly with: Contribution<T>;
  }
  export interface ComponentLifecycle {
    initialize(context: Contracts.InvocationContext): Promise<Contracts.Result<void>>;
    start(context: Contracts.InvocationContext): Promise<Contracts.Result<void>>;
    stop(reason: string): Promise<Contracts.CleanupReport>;
    dispose(): Promise<Contracts.CleanupReport>;
  }
  export interface ScopedService<T> {
    readonly value: T;
    dispose(): Promise<Contracts.CleanupReport>;
  }
  export interface ServiceFactory<T> {
    readonly id: string;
    readonly scope: Contracts.ScopeKind;
    readonly dependencies: readonly {
      readonly id: string;
      readonly contractVersion: number;
      readonly scope: Contracts.ScopeKind;
    }[];
    create(
      config: Contracts.Json,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<ScopedService<T>>>;
  }
  export interface RegistrationPort {
    provide<T>(point: ExtensionPoint<T>, factory: ServiceFactory<T>): Contracts.Result<void>;
    declare<T>(point: ExtensionPoint<T>): Contracts.Result<void>;
    contribute<T>(contribution: Contribution<T>): Contracts.Result<void>;
    replace<T>(replacement: Replacement<T>): Contracts.Result<void>;
  }
  export interface ComponentFactory {
    readonly descriptor: ComponentDescriptor;
    register(registry: RegistrationPort): Contracts.Result<void>;
    create(
      config: Contracts.Json,
      services: Contracts.ServiceAccess,
    ): Contracts.Result<ComponentLifecycle>;
  }
  export interface ResolvedComposition {
    readonly id: Contracts.EntityId;
    readonly revision: Contracts.Revision;
    readonly digest: Contracts.Digest;
    readonly components: readonly ComponentDescriptor[];
    readonly orderedBindings: readonly {
      readonly point: string;
      readonly contributions: readonly string[];
    }[];
    readonly capabilities: Contracts.CapabilitySet;
    readonly configProvenance: readonly {
      readonly key: string;
      readonly source: string;
      readonly effective: Contracts.Json;
    }[];
    readonly warnings: readonly string[];
  }
  export interface CompositionSpec {
    readonly components: readonly ComponentFactory[];
    readonly config: Contracts.Json;
    readonly edits?: readonly ((registry: RegistrationPort) => Contracts.Result<void>)[];
  }
  export interface CompositionHandle {
    readonly inspection: ResolvedComposition;
    readonly localToken: unknown;
  }
  export interface CompositionPlanner {
    resolve(input: CompositionSpec): Contracts.Result<CompositionHandle>;
  }
  export interface ScopeLease {
    readonly scope: Contracts.ScopeRef;
    readonly services: Contracts.ServiceAccess;
    close(): Promise<Contracts.CleanupReport>;
  }
  export interface ScopeManager {
    open(
      scope: Contracts.ScopeRef,
      composition: CompositionHandle,
    ): Promise<Contracts.Result<ScopeLease>>;
  }
  export interface Preset {
    readonly id: Contracts.QualifiedId;
    readonly version: string;
    readonly configSchema: Contracts.SchemaRef;
    expand(config: Contracts.Json): Contracts.Result<CompositionSpec>;
  }
}

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

export namespace Driver {
  export interface InputReceipt {
    readonly accepted: boolean;
    readonly disposition:
      'next-safe-point' | 'next-model-call' | 'follow-up-run' | 'queued' | 'rejected';
    readonly inputId: string;
    readonly reason?: string;
  }
  export interface Services {
    readonly model?: Model.Gateway;
    readonly tools?: Tools.Dispatcher;
    readonly context?: Context.Compiler;
    readonly operations: Runtime.OperationService;
    readonly waits?: Runtime.SuspensionPort;
    readonly services: Contracts.ServiceAccess;
  }
  export interface Instance<I, O> {
    execute(input: I, context: Contracts.InvocationContext): Promise<Runtime.ManagedOutcome<O>>;
    describeActions(context: Contracts.InvocationContext): readonly Contracts.ActionDescriptor[];
    receive(
      actionId: string,
      input: unknown,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<InputReceipt>>;
    dispose(): Promise<Contracts.CleanupReport>;
  }
  export interface Factory<I, O> {
    readonly id: Contracts.QualifiedId;
    readonly version: string;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    readonly requires: readonly Composition.Requirement[];
    create(services: Services, run: Contracts.EntityRef): Instance<I, O>;
  }
}

export namespace Model {
  export interface NativePart {
    readonly provider: Contracts.QualifiedId;
    readonly formatVersion: string;
    readonly affinity?: { readonly profile: string; readonly conversation?: string };
    readonly payload: Contracts.Json;
  }
  export type ContentPart =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'json'; readonly value: Contracts.Json }
    | {
        readonly kind: 'media';
        readonly mediaType: string;
        readonly artifact: Contracts.ArtifactRef;
      }
    | { readonly kind: 'native'; readonly native: NativePart };
  export interface ToolCall {
    readonly id: string;
    readonly toolId: string;
    readonly arguments: Contracts.Json;
    readonly native?: NativePart;
  }
  export interface Response {
    readonly content: readonly ContentPart[];
    readonly toolCalls: readonly ToolCall[];
    readonly finish: { readonly normalized: string; readonly native?: Contracts.Json };
    readonly usage: Runtime.Usage;
    readonly continuation?: NativePart;
  }
  export interface ToolAdvertisement {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: Contracts.Json;
    readonly execution: 'runtime' | 'provider';
    readonly version: string;
  }
  export interface Invocation {
    readonly profileId: string;
    readonly context: Context.CompiledContext;
    readonly tools: readonly ToolAdvertisement[];
    readonly options: Contracts.Json;
    readonly continuation?: NativePart;
  }
  export interface Gateway {
    invoke(
      request: Invocation,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Runtime.ExecutionHandle<Response>>>;
  }
  export interface Profile {
    readonly id: string;
    readonly revision: Contracts.Revision;
    readonly adapterId: string;
    readonly transportId: string;
    readonly authStrategyId: string;
    readonly model: string;
    readonly endpoint?: string;
    readonly defaults: Contracts.Json;
    readonly capabilities: Contracts.CapabilitySet;
  }
  export interface EncodedRequest {
    readonly protocol: string;
    readonly mediaType: string;
    readonly body: Uint8Array;
    readonly digest: Contracts.Digest;
    readonly metadata: Contracts.Json;
    readonly inspectionBoundary: 'outgoing-body' | 'broker-input';
  }
  export interface WireResponse {
    readonly status?: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: AsyncIterable<Uint8Array>;
  }
  export interface ProviderEvent {
    readonly type: string;
    readonly payload: Contracts.Json;
  }
  export interface ResponseDecoder {
    push(chunk: Uint8Array): Contracts.Result<readonly ProviderEvent[]>;
    finish(): Contracts.Result<Response>;
  }
  export interface Adapter {
    readonly id: string;
    encode(invocation: Invocation, profile: Profile): Promise<Contracts.Result<EncodedRequest>>;
    createDecoder(response: {
      readonly status?: number;
      readonly headers: Readonly<Record<string, string>>;
    }): Contracts.Result<ResponseDecoder>;
  }
  export interface CredentialBinding {
    readonly strategy: string;
    readonly material: unknown;
  }
  export interface AuthStrategy {
    bind(
      profile: Profile,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<CredentialBinding>>;
  }
  export interface Transport {
    readonly id: string;
    send(
      request: EncodedRequest,
      profile: Profile,
      auth: CredentialBinding,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<WireResponse>>;
  }
  export interface RequestTransform {
    readonly id: string;
    apply(
      request: EncodedRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<EncodedRequest>>;
  }
  export interface RequestInspection {
    readonly requestId: string;
    readonly contextId: string;
    readonly attemptId: string;
    readonly actualDigest: Contracts.Digest;
    readonly boundary: EncodedRequest['inspectionBoundary'];
    readonly publicPayload?: Contracts.Json;
    readonly redactions: readonly string[];
    readonly transportId: string;
  }
}

export namespace Tools {
  export interface Definition<I, O> {
    readonly id: Contracts.QualifiedId;
    readonly version: string;
    readonly description: string;
    readonly input: Contracts.Schema<I>;
    readonly output?: Contracts.Schema<O>;
    readonly executor: Contracts.QualifiedId;
    readonly effects: 'read' | 'write' | 'external' | 'unknown';
    readonly cancellation: 'cooperative' | 'terminable' | 'unsupported';
    readonly retrySafety: 'never' | 'read-only' | 'idempotency-key' | 'reconcile';
    readonly timeoutMs?: number;
    readonly requiredCapabilities: readonly string[];
  }
  export interface Call {
    readonly logicalCallId: string;
    readonly modelCallId?: string;
    readonly toolId: string;
    readonly arguments: unknown;
    readonly expectedToolVersion?: string;
  }
  export interface CallPlan<I = unknown> {
    readonly call: Call;
    readonly definition: Definition<I, unknown>;
    readonly validatedArguments: I;
    readonly executorId: string;
    readonly revision: Contracts.Revision;
    readonly digest: Contracts.Digest;
    readonly hops: readonly string[];
  }
  export interface ResultContent<O = unknown> {
    readonly value?: O;
    readonly content: readonly Model.ContentPart[];
    readonly artifacts: readonly Contracts.ArtifactRef[];
    readonly diagnostics: readonly Contracts.Json[];
  }
  export type Decision =
    | { readonly kind: 'allow' }
    | { readonly kind: 'replace-arguments'; readonly arguments: unknown; readonly reason: string }
    | { readonly kind: 'deny'; readonly error: Contracts.Failure }
    | { readonly kind: 'substitute'; readonly result: ResultContent; readonly reason: string }
    | {
        readonly kind: 'redirect';
        readonly toolId?: string;
        readonly executorId?: string;
        readonly arguments: unknown;
        readonly reason: string;
      }
    | { readonly kind: 'suspend'; readonly ticket: Runtime.WaitSpec<Contracts.Json> };
  export interface Middleware {
    readonly id: string;
    readonly version: string;
    decide(
      plan: CallPlan,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Decision>>;
    resume?(
      plan: CallPlan,
      ticket: Runtime.WaitTicket,
      response: Contracts.Json,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Decision>>;
  }
  export interface ExecutionContext extends Contracts.InvocationContext {
    readonly operationId: string;
    readonly attemptId: string;
    readonly workspace?: Contracts.DataRef;
    readonly environmentHandle?: unknown;
    readonly progress: Runtime.ProgressSink;
    readonly resources?: Host.ResourceManager;
  }
  export interface FunctionBinding<I, O> {
    readonly definition: Definition<I, O>;
    execute(input: I, context: ExecutionContext): Promise<Contracts.Result<ResultContent<O>>>;
  }
  export interface InstalledTool {
    readonly id: string;
    readonly version: string;
    readonly localBinding: unknown;
  }
  export interface BindingFactory {
    install<I, O>(binding: FunctionBinding<I, O>): InstalledTool;
  }
  export interface Executor {
    readonly id: string;
    readonly capabilities: Contracts.CapabilitySet;
    execute(
      plan: CallPlan,
      permit: Runtime.AttemptPermit,
      context: ExecutionContext,
    ): Promise<Runtime.AttemptOutcome<ResultContent>>;
    reconcile?(
      attempt: Runtime.EffectPlan,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.EffectState>>;
  }
  export interface Registry {
    resolve(id: string, expectedVersion?: string): Contracts.Result<Definition<unknown, unknown>>;
    list(context: Contracts.InvocationContext): readonly Definition<unknown, unknown>[];
  }
  export interface Dispatcher {
    dispatch(
      call: Call,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Runtime.ExecutionHandle<ResultContent>>>;
  }
  export interface OutputProjector {
    readonly id: string;
    forModel(
      result: ResultContent,
      budget: number,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Model.ContentPart[]>>;
  }
}

export namespace History {
  export interface Record<T = Contracts.Json> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly payload: T;
    readonly provenance: Contracts.Provenance;
    readonly visibility: {
      readonly model: boolean;
      readonly conversation: boolean;
      readonly inspector: boolean;
      readonly export: boolean;
    };
    readonly createdAt: Contracts.Timestamp;
  }
  export interface Branch {
    readonly id: string;
    readonly sessionId: string;
    readonly head?: string;
    readonly revision: Contracts.Revision;
  }
  export interface Entry {
    readonly entryId: string;
    readonly previous?: string;
    readonly record: Record;
  }
  export interface Service {
    createSession(
      metadata: Contracts.Json,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.EntityRef>>;
    fork(
      branch: Branch,
      atEntry: string | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Branch>>;
    append(
      branch: Branch,
      records: readonly Record[],
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Branch>>;
    path(
      branch: Branch,
      cursor: string | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Page<Entry>>>;
  }
}

export namespace Context {
  export type SourceRef =
    | { readonly kind: 'record'; readonly owner: string; readonly recordId: string }
    | { readonly kind: 'external'; readonly ref: Contracts.DataRef }
    | { readonly kind: 'inline'; readonly id: string; readonly digest: string }
    | { readonly kind: 'artifact'; readonly ref: Contracts.ArtifactRef };
  export interface SemanticItem<T = unknown> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly payload: T;
    readonly source: SourceRef;
    readonly provenance: Contracts.Provenance;
  }
  export interface SourceVersion {
    readonly source: SourceRef;
    readonly observed: Contracts.Revision;
    readonly fidelity: 'version-pinned' | 'observed-only' | 'content-addressed';
  }
  export interface Selection {
    readonly source: SourceRef;
    readonly required: boolean;
    readonly reason: string;
    readonly selectorData?: Contracts.Json;
  }
  export interface Plan {
    readonly id: string;
    readonly selections: readonly Selection[];
    readonly policyRevision: string;
  }
  export interface Request {
    readonly sources: readonly SourceRef[];
    readonly input: readonly SemanticItem[];
    readonly modelCapabilities: Contracts.CapabilitySet;
    readonly toolsDigest: string;
    readonly budget?: number;
  }
  export interface Planner {
    plan(request: Request, context: Contracts.InvocationContext): Promise<Contracts.Result<Plan>>;
  }
  export interface Resolver {
    readonly id: string;
    resolve(
      selection: Selection,
      context: Contracts.InvocationContext,
    ): Promise<
      Contracts.Result<{
        readonly items: readonly SemanticItem[];
        readonly versions: readonly SourceVersion[];
      }>
    >;
  }
  export interface Fragment {
    readonly id: string;
    readonly kind: 'instruction' | 'message' | 'reference' | 'tool-call' | 'tool-result' | 'native';
    readonly role?: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
    readonly content: readonly Model.ContentPart[];
    readonly toolRelation?: { readonly callId: string; readonly toolId: string };
    readonly sources: readonly SourceRef[];
    readonly provenance: Contracts.Provenance;
  }
  export type Lowering =
    | { readonly kind: 'include'; readonly fragments: readonly Fragment[] }
    | { readonly kind: 'omit'; readonly reason: string };
  export interface Lowerer<T> {
    readonly id: string;
    readonly accepts: Contracts.SchemaRef;
    lower(item: SemanticItem<T>): Contracts.Result<Lowering>;
  }
  export interface SetTransform {
    readonly id: string;
    transform(
      fragments: readonly Fragment[],
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Fragment[]>>;
  }
  export interface Assembly {
    readonly fragments: readonly Fragment[];
    readonly sourceMap: readonly {
      readonly fragmentId: string;
      readonly sources: readonly SourceRef[];
    }[];
  }
  export interface Assembler {
    assemble(fragments: readonly Fragment[]): Contracts.Result<Assembly>;
  }
  export interface CompiledContext extends Assembly {
    readonly id: string;
    readonly digest: string;
    readonly compositionRevision: string;
    readonly toolsDigest: string;
    readonly modelCapabilitiesRevision: string;
    readonly sourceVersions: readonly SourceVersion[];
    readonly decisions: readonly {
      readonly source: SourceRef;
      readonly disposition: 'include' | 'omit';
      readonly reason: string;
      readonly component: string;
    }[];
    readonly consistency: 'per-source' | 'atomic-owner-snapshot';
    readonly losses: readonly string[];
  }
  export interface Compiler {
    compile(
      request: Request,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<CompiledContext>>;
  }
}

export namespace Control {
  export interface ActionBinding<I, O> {
    readonly id: string;
    readonly version: number;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    describe(
      target: Contracts.EntityRef | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.ActionDescriptor>>;
    execute(
      request: Contracts.CommandRequest<I>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.CommandReceipt<O>>;
  }
  export interface ActionGateway {
    invoke(
      request: Contracts.CommandRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.CommandReceipt>;
    describe(
      target: Contracts.EntityRef | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Contracts.ActionDescriptor[]>>;
  }
}

export namespace Projection {
  export interface Audience {
    readonly target: 'chat' | 'inspector' | 'document' | 'overlay' | 'export' | string;
    readonly authorizationRevision: string;
  }
  export interface SafeFallback {
    readonly label: string;
    readonly text?: string;
    readonly detail?: Contracts.Json;
  }
  export interface Item<T = Contracts.Json> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly revision: string;
    readonly source?: Contracts.EntityRef;
    readonly payload: T;
    readonly fallback: SafeFallback;
    readonly actions: readonly Contracts.ActionDescriptor[];
    readonly artifacts: readonly Contracts.ArtifactRef[];
  }
  export interface Projector<T> {
    readonly id: string;
    project(
      value: T,
      audience: Audience,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Item[]>>;
  }
  export interface Service {
    read(
      target: Contracts.EntityRef,
      audience: Audience,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Item[]>>;
  }
}

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

export namespace Client {
  export type CommandDelivery<O = Contracts.Json> =
    | { readonly kind: 'not-sent'; readonly commandId: string; readonly error: Contracts.Failure }
    | { readonly kind: 'receipt'; readonly receipt: Contracts.CommandReceipt<O> }
    | {
        readonly kind: 'unknown';
        readonly commandId: string;
        readonly error: Contracts.Failure;
        readonly recovery: 'query-status' | 'same-key-retry' | 'manual';
      };
  export interface StreamPartSnapshot {
    readonly itemId: string;
    readonly partId: string;
    readonly generation: string;
    readonly text: string;
    readonly offset: number;
    readonly completed: boolean;
  }
  export interface TextDelta {
    readonly itemId: string;
    readonly partId: string;
    readonly generation: string;
    readonly offset: number;
    readonly text: string;
  }
  export interface QueryBinding<I, O> {
    readonly id: string;
    readonly version: number;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    read(input: I, context: Contracts.InvocationContext): Promise<Contracts.Result<O>>;
  }
  export interface Endpoint {
    command(
      request: Contracts.CommandRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.CommandReceipt>;
    query(
      request: Contracts.QueryRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Json>>;
    watch(
      request: WatchRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<WatchSession>>;
  }
  export interface EventEnvelope<T = Contracts.Json> {
    readonly protocolVersion: number;
    readonly epoch: string;
    readonly streamId: string;
    readonly sequence: number;
    readonly cursor: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly persistence: 'state-backed' | 'delta' | 'ephemeral';
    readonly causationId?: string;
    readonly correlationId?: string;
    readonly runId?: string;
    readonly operationId?: string;
    readonly payload: T;
  }
  export interface Snapshot {
    readonly epoch: string;
    readonly streamId: string;
    readonly throughSequence: number;
    readonly cursor: string;
    readonly audienceRevision: string;
    readonly items: readonly Projection.Item[];
    readonly streamingParts: readonly StreamPartSnapshot[];
    readonly capabilities: Contracts.CapabilitySet;
  }
  export type StreamFrame =
    | { readonly kind: 'event'; readonly event: EventEnvelope }
    | { readonly kind: 'reset'; readonly snapshot: Snapshot }
    | {
        readonly kind: 'gap';
        readonly recovery: 'replay' | 'snapshot' | 'unavailable';
        readonly lastCursor?: string;
        readonly reason: string;
      };
  export interface WatchRequest {
    readonly target?: Contracts.EntityRef;
    readonly surface: string;
    readonly resumeCursor?: string;
  }
  export interface WatchSession {
    readonly bootstrap: Snapshot;
    readonly frames: AsyncIterable<StreamFrame>;
    close(): Promise<void>;
  }
  export interface Port {
    command(
      request: Contracts.CommandRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<CommandDelivery>;
    query(
      request: Contracts.QueryRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Contracts.Result<Contracts.Json>>;
    discover(target?: Contracts.EntityRef): Promise<Contracts.Result<Contracts.CapabilitySet>>;
    watch(
      request: WatchRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Contracts.Result<WatchSession>>;
  }
  export interface State {
    readonly epoch?: string;
    readonly connection: 'offline' | 'connecting' | 'connected' | 'resyncing';
    readonly itemIds: readonly string[];
    readonly pendingCommands: readonly string[];
  }
  export interface Selector<T> {
    select(state: State, getItem: (id: string) => Projection.Item | undefined): T;
    equal(left: T, right: T): boolean;
  }
  export interface Controller {
    readonly port: Port;
    getState(): State;
    getItem(id: string): Projection.Item | undefined;
    subscribe<T>(selector: Selector<T>, listener: (next: T) => void): () => void;
    connect(request: WatchRequest): Promise<Contracts.Result<void>>;
    disconnect(): Promise<void>;
    invoke(request: Contracts.CommandRequest): Promise<CommandDelivery>;
    dispose(): Promise<void>;
  }
  export interface Codec {
    encode(value: Contracts.Json): Contracts.Result<Uint8Array>;
    decode(bytes: Uint8Array): Contracts.Result<Contracts.Json>;
  }
}

export namespace UI {
  export type RenderTarget = 'chat' | 'inspector' | 'document' | 'overlay' | string;
  export interface RenderContext {
    readonly controller: Client.Controller;
    readonly target: RenderTarget;
    readonly itemId: string;
  }
  export interface Renderer<T, View> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersions: readonly number[];
    readonly target: RenderTarget;
    render(item: Projection.Item<T>, context: RenderContext): View;
  }
  export interface RendererRegistry<View> {
    resolve(
      item: Projection.Item,
      target: RenderTarget,
    ): Contracts.Result<Renderer<Contracts.Json, View>>;
  }
  export interface SlotContribution<View> {
    readonly id: string;
    readonly slot: string;
    readonly before?: readonly string[];
    readonly after?: readonly string[];
    render(context: RenderContext): View;
  }
  export interface Draft {
    readonly text: string;
    readonly references: readonly Contracts.DataRef[];
    readonly revision: number;
  }
  export interface ComposerController {
    getDraft(): Draft;
    setDraft(draft: Draft): void;
    setComposing(active: boolean): void;
    submit(origin: 'enter' | 'button' | 'api'): Promise<Client.CommandDelivery>;
    canSubmit(): { readonly allowed: boolean; readonly reason?: string };
  }
  export interface ScrollState {
    readonly anchoredItemId?: string;
    readonly following: boolean;
    readonly hasNewContent: boolean;
  }
  export interface ScrollController {
    getState(): ScrollState;
    onUserScroll(distanceFromLatest: number): void;
    followLatest(): void;
    preserveAnchor(itemId: string): void;
  }
  export interface Parts {
    readonly Message: unknown;
    readonly Composer: unknown;
    readonly ToolDetails: unknown;
    readonly Fallback: unknown;
  }
  export interface ChatOptions<View> {
    readonly client: Client.Controller;
    readonly ownsClient?: boolean;
    readonly renderers?: readonly Renderer<Contracts.Json, View>[];
    readonly slots?: readonly SlotContribution<View>[];
    readonly components?: Partial<Parts>;
    readonly className?: string;
    readonly theme?: Readonly<Record<string, string>>;
  }
  /** Framework binding supplies actual React/Vue/etc. component/ref/event types; not fixed here. */
  export interface HeadlessBinding<View> {
    readonly contractVersion: number;
    createChat(options: ChatOptions<View>): View;
  }
}

export namespace Host {
  export interface AdmissionRequest<I = Contracts.Json> {
    readonly requestId: string;
    readonly run: Runtime.RunRequest<I>;
    readonly concurrencyKey?: string;
    readonly priority?: number;
    readonly expiresAt?: string;
  }
  export type Admission =
    | { readonly kind: 'started'; readonly run: Contracts.EntityRef }
    | { readonly kind: 'queued'; readonly job: Contracts.EntityRef }
    | { readonly kind: 'superseded'; readonly by: string }
    | { readonly kind: 'rejected'; readonly error: Contracts.Failure };
  export interface Service {
    start(context: Contracts.InvocationContext): Promise<Contracts.Result<void>>;
    submit(
      request: AdmissionRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Admission>>;
    stop(options: {
      readonly mode: 'drain' | 'cancel';
      readonly deadline?: string;
    }): Promise<Contracts.CleanupReport>;
  }
  export interface InputPolicy {
    decide(
      request: AdmissionRequest,
      pending: readonly AdmissionRequest[],
    ): Contracts.Result<{
      readonly action: 'start' | 'queue' | 'replace-pending' | 'reject';
      readonly affected: readonly string[];
    }>;
  }
  export interface RuntimeResource {
    readonly ref: Contracts.ResourceRef;
    readonly owner: Contracts.ScopeRef;
    readonly transferable: boolean;
    close(reason: string): Promise<Contracts.Result<void>>;
  }
  export interface ResourceManager {
    register(resource: RuntimeResource): Contracts.Result<Contracts.ResourceRef>;
    transfer(ref: Contracts.ResourceRef, target: Contracts.ScopeRef): Contracts.Result<void>;
    closeOwner(owner: Contracts.ScopeRef): Promise<Contracts.CleanupReport>;
  }
}

export namespace Testing {
  export interface Candidate {
    readonly id: string;
    readonly revision: string;
    readonly components: readonly string[];
    readonly config: Contracts.Json;
  }
  export interface Evidence {
    readonly testId: string;
    readonly candidate: Candidate;
    readonly result: 'pass' | 'fail' | 'not-run' | 'unsupported';
    readonly effectsObserved: Contracts.Json;
    readonly logs: readonly string[];
    readonly measurements?: Contracts.Json;
  }
  export interface ContractSuite {
    readonly id: string;
    run(candidate: Candidate): Promise<readonly Evidence[]>;
  }
}

export namespace Convenience {
  export interface ConfiguredModel {
    readonly profile: Model.Profile;
    readonly adapter: Model.Adapter;
    readonly transport: Model.Transport;
    readonly auth: Model.AuthStrategy;
  }
  export interface BaseOptions {
    readonly model: ConfiguredModel;
    readonly tools?: readonly Tools.InstalledTool[];
    readonly limits?: Runtime.ExecutionLimits;
    readonly components?: readonly Composition.ComponentFactory[];
    readonly customize?: (base: Composition.CompositionSpec) => Composition.CompositionSpec;
  }
  export interface DefaultOptions extends BaseOptions {
    readonly driver?: never;
  }
  export interface CustomOptions<I, O> extends BaseOptions {
    readonly driver: Driver.Factory<I, O>;
  }
  export interface Agent<I, O> {
    start(input: I): Promise<Contracts.Result<Runtime.ExecutionHandle<O>>>;
    generate(input: I): Promise<Contracts.Result<Runtime.ManagedOutcome<O>>>;
    inspectComposition(): Composition.ResolvedComposition;
    dispose(): Promise<Contracts.CleanupReport>;
  }
  export interface Factory {
    create(
      options: DefaultOptions,
    ): Contracts.Result<Agent<string | readonly Context.SemanticItem[], Model.Response>>;
    create<I, O>(options: CustomOptions<I, O>): Contracts.Result<Agent<I, O>>;
  }
}

export namespace ControlCatalog {
  /** Proposed built-in wire inputs. A host resolves composition/profile references locally. */
  export interface RunStartInput {
    readonly driverId: string;
    readonly input: Contracts.Json;
    readonly composition: { readonly id: string; readonly revision: string };
    readonly limits?: Runtime.ExecutionLimits;
    readonly history?: {
      readonly sessionId: string;
      readonly branchId: string;
      readonly expectedHead?: string;
    };
  }
  export interface RunCancelInput {
    readonly run: Contracts.EntityRef;
    readonly reason: string;
  }
  export interface WaitResponseInput {
    readonly ticketId: string;
    readonly expectedRevision: string;
    readonly response: Contracts.Json;
  }
  export interface HistoryForkInput {
    readonly branchId: string;
    readonly expectedRevision: string;
    readonly atEntry?: string;
  }
  export interface InspectInput {
    readonly target: Contracts.EntityRef;
    readonly view: string;
  }
  /** Wire selects already registered/authorized definitions; no executable module bytes or local handle. */
  export interface WorkflowStartInput {
    readonly engineId: string;
    readonly definition: { readonly id: string; readonly digest: string };
    readonly profileId: string;
    readonly composition: { readonly id: string; readonly revision: string };
    readonly input: Contracts.Json;
    readonly limits?: Runtime.ExecutionLimits;
    readonly requiredControl: 'instruction-only' | 'runner-enforced';
    readonly requiredCapabilities: readonly string[];
  }
  export interface WorkflowActionInput {
    readonly execution: Workflows.ExecutionRef;
    readonly actionId: string;
    readonly actionVersion: number;
    readonly expectedRevision: string;
    readonly input: Contracts.Json;
  }
}

/** Optional neutral result transport/validation module. No implicit business actions. */
export namespace Results {
  export interface TypeDefinition<T> {
    readonly id: string;
    readonly version: number;
    readonly schema: Contracts.Schema<T>;
    readonly mediaType: string;
  }
  export type Input =
    | { readonly kind: 'inline'; readonly value: Contracts.Json }
    | {
        readonly kind: 'artifact';
        readonly ref: Contracts.ArtifactRef;
        readonly expectedDigest: string;
      }
    | { readonly kind: 'captured'; readonly captureId: string; readonly expectedDigest: string };
  export interface Validation {
    readonly validator: string;
    readonly version: string;
    readonly inputDigest: string;
    readonly outputDigest?: string;
    readonly status: 'pass' | 'fail';
    readonly diagnostics: readonly Contracts.Issue[];
  }
  export interface Accepted {
    readonly id: string;
    readonly type: Contracts.SchemaRef;
    readonly data: Input;
    readonly digest: string;
    readonly producedBy: Contracts.EntityRef;
    readonly definitionDigest?: string;
    readonly validation: readonly Validation[];
    readonly provenance: Contracts.Provenance;
    readonly commit: readonly Contracts.CommitEvidence[];
  }
  export interface Submission {
    readonly submissionId: string;
    readonly expectedType: Contracts.SchemaRef;
    readonly data: Input;
    readonly producedBy: Contracts.EntityRef;
    readonly validationProfile: string;
  }
  export interface Processor {
    readonly id: string;
    readonly version: string;
    readonly inputType: Contracts.SchemaRef;
    readonly outputType: Contracts.SchemaRef;
    process(
      input: Input,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<{ readonly output: Input; readonly evidence: Validation }>>;
  }
  export interface Service {
    submit(
      input: Submission,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Accepted>>;
    read(id: string, context: Contracts.InvocationContext): Promise<Contracts.Result<Accepted>>;
  }
}

/** Optional script host. Packaging and business meanings are not known by this API. */
export namespace Scripts {
  export interface Source {
    readonly packageId?: string;
    readonly relativePath: string;
    readonly digest: string;
  }
  export type OutputCapture =
    | { readonly kind: 'stdout-json'; readonly maxBytes: number }
    | {
        readonly kind: 'file';
        readonly relativePath: string;
        readonly mediaType: string;
        readonly maxBytes: number;
      }
    | {
        readonly kind: 'channel';
        readonly channelId: string;
        readonly protocolVersion: number;
        readonly maxBytes: number;
      }
    | { readonly kind: 'none' };
  export interface Request {
    readonly requestId: string;
    readonly executorId: string;
    readonly source: Source;
    readonly interpreter: string;
    readonly args: readonly string[];
    readonly stdin?: Contracts.Json;
    readonly workspace?: Contracts.DataRef;
    readonly environmentProfile?: string;
    readonly timeoutMs?: number;
    readonly capture: OutputCapture;
    readonly effects: 'read' | 'write' | 'external' | 'unknown';
    readonly retry: 'never' | 'read-only' | 'idempotent' | 'reconcile';
    readonly bridgeGrant?: string;
  }
  export interface Output {
    readonly exitCode: number | null;
    readonly termination: 'exited' | 'signal' | 'timeout' | 'lost';
    readonly captured?: Results.Input;
    readonly stdout?: Contracts.ArtifactRef;
    readonly stderr?: Contracts.ArtifactRef;
    readonly completeness: 'complete' | 'truncated' | 'unknown';
    readonly executionDigest: string;
  }
  export interface Service {
    execute(
      input: Request,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Runtime.ExecutionHandle<Output>>>;
  }
  /** Hooked to an actual IPC/security mechanism by the selected script host. */
  export interface BridgeGrant {
    readonly id: string;
    readonly version: number;
    readonly audience: string;
    readonly owner: Contracts.EntityRef;
    readonly allowedMethods: readonly string[];
    readonly allowedProfiles: readonly string[];
    readonly limits: Runtime.ExecutionLimits;
    readonly expiresAt: string;
    readonly enforcement: 'trusted-code-only' | 'authenticated-channel';
  }
  export interface BridgeRequest {
    readonly id: string;
    readonly grantId: string;
    readonly method: string;
    readonly params: Contracts.Json;
  }
  export interface BridgeHost {
    issue(
      policy: Omit<BridgeGrant, 'id'>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<BridgeGrant>>;
    invoke(
      request: BridgeRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.CommandReceipt>;
    revoke(grantId: string, context: Contracts.InvocationContext): Promise<Contracts.Result<void>>;
  }
}

/** A content package is NOT a loaded runtime extension. All loading remains opt-in. */
export namespace Packages {
  export interface Asset {
    readonly path: string;
    readonly digest: string;
    readonly mediaType: string;
    readonly bytes?: number;
  }
  export interface Snapshot {
    readonly id: string;
    readonly version?: string;
    readonly digest: string;
    readonly assets: readonly Asset[];
    readonly origin: string;
    readonly trustProfile: string;
  }
  export interface Source {
    discover(
      roots: readonly string[],
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Snapshot[]>>;
    read(
      snapshot: Snapshot,
      path: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Uint8Array>>;
  }
  export interface UnsupportedField {
    readonly path: string;
    readonly significance: 'presentation' | 'optional' | 'required-behavior';
    readonly reason: string;
  }
  export interface CompatibilityReport {
    readonly format: string;
    readonly sourceVersion: string;
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly status: 'exact-tested-subset' | 'partial' | 'unsupported';
    readonly ignored: readonly UnsupportedField[];
    readonly semantics: readonly string[];
  }
  export interface Decoder<T> {
    readonly id: string;
    readonly format: string;
    decode(
      snapshot: Snapshot,
      source: Source,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<{ readonly value: T; readonly report: CompatibilityReport }>>;
  }
}

/** Optional Agent Skills reader. Activation contributes context, not an implicit workflow. */
export namespace Skills {
  export interface Descriptor {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly package: Packages.Snapshot;
    readonly instructionPath: string;
    readonly references: readonly string[];
    readonly requiredCapabilities: readonly string[];
  }
  export interface ActivationRequest {
    readonly skillId: string;
    readonly packageDigest: string;
    readonly owner: Contracts.EntityRef;
    readonly purpose: string;
    readonly scope: 'invocation' | 'run' | 'session';
  }
  export interface Activation {
    readonly id: string;
    readonly descriptor: Descriptor;
    readonly owner: Contracts.EntityRef;
    readonly scope: ActivationRequest['scope'];
    readonly contextItems: readonly Context.SemanticItem[];
    readonly warnings: readonly string[];
  }
  export interface Service {
    list(context: Contracts.InvocationContext): Promise<Contracts.Result<readonly Descriptor[]>>;
    activate(
      request: ActivationRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Activation>>;
    deactivate(id: string, context: Contracts.InvocationContext): Promise<Contracts.Result<void>>;
  }
  /** Arbitrary extension payload; owning decoder decides semantics. The core never parses it. */
  export interface ExtensionDocument {
    readonly namespace: string;
    readonly formatVersion: string;
    readonly requires: readonly Composition.Requirement[];
    readonly payload: Contracts.Json;
  }
}

/** Optional event/script adapter. Enforcement points are declared by their owning layer. */
export namespace Hooks {
  export interface Point<I, O> {
    readonly id: string;
    readonly version: number;
    readonly owner: string;
    readonly phase: 'before-effect' | 'after-effect' | 'lifecycle' | 'observation';
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    readonly allowedDecisions: readonly string[];
    readonly awaited: boolean;
  }
  export interface Binding {
    readonly id: string;
    readonly pointId: string;
    readonly pointVersion: number;
    readonly activationOwner: Contracts.EntityRef;
    readonly match?: Contracts.Json;
    readonly script: Scripts.Request;
    readonly failure: 'block' | 'fail-run' | 'report-and-continue';
    readonly scope: 'invocation' | 'run' | 'session' | 'host';
    readonly once: boolean;
    readonly reentrancy: 'deny' | 'explicit-bounded';
  }
  export interface Service {
    bind(
      binding: Binding,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.EntityRef>>;
    unbind(
      ref: Contracts.EntityRef,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<void>>;
  }
}

/** All workflow contracts below belong to OPTIONAL packages, never the mandatory kernel. */
export namespace Workflows {
  export type Form = 'code' | 'pipeline' | 'recipe' | 'external' | 'custom';
  export interface DefinitionRef {
    readonly id: string;
    readonly format: string;
    readonly formatVersion: string;
    readonly digest: string;
    readonly source:
      | { readonly package: Packages.Snapshot; readonly entry: string }
      | { readonly owner: string; readonly native: Contracts.Json };
  }
  export interface Guarantees {
    readonly control: 'instruction-only' | 'runner-enforced';
    readonly effects: 'runner-path-only' | 'policy-mediated' | 'isolated-grants';
    readonly checkpoint: 'none' | 'whole-invocation' | 'declared-step' | 'engine-native';
    readonly submissionDedupe: 'none' | 'memory' | 'durable';
    readonly scriptCancellation: 'cooperative' | 'process-tree' | 'unsupported' | 'engine-native';
    readonly nativeSemantics: readonly string[];
  }
  export interface EngineDescriptor {
    readonly id: string;
    readonly version: string;
    readonly forms: readonly Form[];
    readonly formats: readonly { readonly id: string; readonly versions: readonly string[] }[];
    readonly capabilities: Contracts.CapabilitySet;
  }
  export interface PrepareRequest {
    readonly definition: DefinitionRef;
    readonly engineId: string;
    readonly profileId: string;
    readonly requiredCapabilities: readonly string[];
    readonly requiredControl: 'instruction-only' | 'runner-enforced';
  }
  export interface Prepared {
    readonly definition: DefinitionRef;
    readonly engine: EngineDescriptor;
    readonly compositionRevision: string;
    readonly input: Contracts.SchemaRef;
    readonly output: Contracts.SchemaRef;
    readonly guarantees: Guarantees;
    readonly compatibility: Packages.CompatibilityReport;
    readonly report: readonly string[];
    /** Process-local compiled value or adapter token. Not a serialized continuation. */
    readonly localHandle: unknown;
  }
  export interface ExecutionRef {
    readonly engine: string;
    readonly engineVersion: string;
    readonly id: string;
    readonly native?: Contracts.Json;
  }
  export type Output =
    | { readonly kind: 'validated'; readonly value: Results.Accepted }
    | {
        readonly kind: 'native';
        readonly data: Contracts.Json;
        readonly validation: 'engine-reported' | 'unverified';
        readonly provenance: Contracts.Provenance;
      };
  export interface NativeState {
    readonly schema: Contracts.SchemaRef;
    readonly data: Contracts.Json;
  }
  export interface Snapshot {
    readonly ref: ExecutionRef;
    readonly revision: string;
    readonly definitionDigest: string;
    readonly owner: string;
    readonly phase:
      'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    readonly nativeState: NativeState;
    readonly guarantees: Guarantees;
    readonly activeOperations: readonly Contracts.EntityRef[];
    readonly waitingOn: readonly Contracts.EntityRef[];
    readonly output?: Output;
    readonly diagnostics: readonly Contracts.Failure[];
    readonly actions: readonly Contracts.ActionDescriptor[];
    readonly effect: Contracts.EffectState;
  }
  export interface StartRequest {
    readonly requestId: string;
    readonly idempotencyKey?: string;
    readonly prepared: Prepared;
    readonly input: Contracts.Json;
    readonly limits?: Runtime.ExecutionLimits;
    readonly parent?: Contracts.EntityRef;
  }
  export type Submission =
    | { readonly kind: 'accepted'; readonly ref: ExecutionRef; readonly snapshot: Snapshot }
    | { readonly kind: 'rejected'; readonly error: Contracts.Failure }
    | {
        readonly kind: 'unknown';
        readonly requestId: string;
        readonly reconciliationKey: string;
        readonly error: Contracts.Failure;
      };
  export interface InspectView {
    readonly kind: string;
    readonly schema: Contracts.SchemaRef;
    readonly data: Contracts.Json;
  }
  export interface Engine {
    readonly descriptor: EngineDescriptor;
    prepare(
      request: PrepareRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Prepared>>;
    start(request: StartRequest, context: Contracts.InvocationContext): Promise<Submission>;
    get(
      ref: ExecutionRef,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Snapshot>>;
    requestCancel(
      ref: ExecutionRef,
      reason: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Runtime.Cancellation>>;
    observe(ref: ExecutionRef, context: Contracts.InvocationContext): AsyncIterable<Runtime.Update>;
    action(
      ref: ExecutionRef,
      command: Contracts.CommandRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.CommandReceipt>;
    inspect?(
      ref: ExecutionRef,
      view: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<InspectView>>;
    reconcileSubmission?(
      key: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<ExecutionRef | null>>;
  }
  /** This point is declared by workflow-host, not by the kernel. */
  export interface Host {
    readonly engines: Composition.ExtensionPoint<Engine>;
    resolve(engineId: string): Contracts.Result<Engine>;
    prepare(
      request: PrepareRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Prepared>>;
    start(request: StartRequest, context: Contracts.InvocationContext): Promise<Submission>;
  }
  export interface CallIdentity {
    readonly workflow: ExecutionRef;
    readonly stepKey: string;
    readonly iterationPath: readonly (string | number)[];
    readonly attempt: number;
    readonly inputDigest: string;
  }
  /** A convenience port for code/pipeline plugins. Other engines need not implement it. */
  export interface StepContext {
    readonly execution: ExecutionRef;
    readonly signal: AbortSignal;
    readonly limits: Runtime.ExecutionLimits;
    script(
      identity: CallIdentity,
      request: Scripts.Request,
    ): Promise<Runtime.ManagedOutcome<Scripts.Output>>;
    agent(
      identity: CallIdentity,
      request: Runtime.RunRequest<Contracts.Json>,
    ): Promise<Runtime.ManagedOutcome<unknown>>;
    model(
      identity: CallIdentity,
      request: Model.Invocation,
    ): Promise<Runtime.ManagedOutcome<Model.Response>>;
    submit(
      identity: CallIdentity,
      request: Results.Submission,
    ): Promise<Contracts.Result<Results.Accepted>>;
    wait(
      identity: CallIdentity,
      request: Runtime.WaitSpec<Contracts.Json>,
    ): Promise<Contracts.Result<Runtime.WaitTicket>>;
    response(ticket: Runtime.WaitTicket): Promise<Contracts.Result<Contracts.Json>>;
  }
  export interface CodeDefinition<I extends Contracts.Json, O extends Contracts.Json> {
    readonly id: string;
    readonly version: string;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    readonly replay: 'none' | 'engine-managed';
    execute(input: I, context: StepContext): Promise<Contracts.Result<O>>;
  }
  /** State is owned by the workflow engine; this is only its storage adapter. */
  export interface Checkpoint {
    readonly execution: ExecutionRef;
    readonly definitionDigest: string;
    readonly engineVersion: string;
    readonly revision: string;
    readonly stateSchema: Contracts.SchemaRef;
    readonly state: Contracts.Json;
    readonly completedCalls: readonly {
      readonly identity: CallIdentity;
      readonly resultRef: string;
      readonly digest: string;
    }[];
    readonly pendingEffects: readonly Runtime.EffectPlan[];
  }
  export interface CheckpointStore {
    read(
      ref: ExecutionRef,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Checkpoint | null>>;
    commit(
      expectedRevision: string | 'absent',
      checkpoint: Checkpoint,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.CommitEvidence>>;
  }
  export interface ExternalBoundary {
    readonly owner: string;
    readonly nativeCheckpointUnit: string;
    readonly innerAgentEffectsCheckpointed: boolean;
    readonly managedEffectCoverage: readonly string[];
    readonly nativeReplaySemantics: string;
  }
  export interface AgentStepBinding {
    readonly id: string;
    readonly boundary: ExternalBoundary;
    startOrAttach(
      key: string,
      request: Runtime.RunRequest<Contracts.Json>,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.EntityRef>>;
    result(
      ref: Contracts.EntityRef,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Runtime.ManagedOutcome<unknown>>>;
  }
  export interface VisualNodeType {
    readonly id: string;
    readonly version: number;
    readonly config: Contracts.SchemaRef;
    readonly inputs: readonly Contracts.SchemaRef[];
    readonly outputs: readonly Contracts.SchemaRef[];
    readonly engineBinding: string;
  }
  export interface VisualCompiler {
    compile(
      graph: Contracts.Json,
      supported: readonly VisualNodeType[],
    ): Contracts.Result<{
      readonly definition: Contracts.Json;
      readonly format: string;
      readonly sourceMap: Contracts.Json;
    }>;
  }
}

/** A proposed, limited pipeline format owned solely by workflow-pipeline-v1. */
export namespace PipelineV1 {
  export type Value =
    | { readonly literal: Contracts.Json }
    | { readonly input: string }
    | { readonly step: string; readonly pointer: string };
  export interface BaseStep {
    readonly id: string;
    readonly after: readonly string[];
    readonly timeoutMs?: number;
  }
  export type Step =
    | (BaseStep & {
        readonly kind: 'extension';
        readonly handler: string;
        readonly handlerVersion: number;
        readonly input: Value;
        readonly config: Contracts.Json;
      })
    | (BaseStep & {
        readonly kind: 'script';
        readonly request: Scripts.Request;
        readonly stdin: Value;
      })
    | (BaseStep & {
        readonly kind: 'agent';
        readonly profile: string;
        readonly input: Value;
        readonly skills?: readonly { readonly id: string; readonly digest: string }[];
      })
    | (BaseStep & {
        readonly kind: 'validate';
        readonly value: Value;
        readonly schema: Contracts.SchemaRef;
      })
    | (BaseStep & {
        readonly kind: 'wait';
        readonly response: Contracts.SchemaRef;
        readonly binding: Value;
        readonly prompt: string;
      })
    | (BaseStep & {
        readonly kind: 'assert';
        readonly value: Value;
        readonly equals: Contracts.Json;
      })
    | (BaseStep & {
        readonly kind: 'branch';
        readonly value: Value;
        readonly cases: readonly {
          readonly equals: Contracts.Json;
          readonly run: readonly Step[];
        }[];
        readonly otherwise?: readonly Step[];
      })
    | (BaseStep & {
        readonly kind: 'repeat';
        readonly maxIterations: number;
        readonly body: readonly Step[];
        readonly until: { readonly value: Value; readonly equals: Contracts.Json };
      })
    | (BaseStep & {
        readonly kind: 'parallel';
        readonly maxConcurrency: number;
        readonly onError: 'cancel-and-join' | 'collect';
        readonly branches: readonly (readonly Step[])[];
      });
  export interface StepHandler<I extends Contracts.Json, O extends Contracts.Json> {
    readonly id: string;
    readonly version: number;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    readonly config: Contracts.Schema<Contracts.Json>;
    readonly requires: readonly string[];
    readonly effects: 'read' | 'write' | 'external' | 'unknown';
    readonly replay: 'never' | 'idempotent-with-key' | 'engine-managed';
    execute(
      input: I,
      config: Contracts.Json,
      identity: Workflows.CallIdentity,
      context: Workflows.StepContext,
    ): Promise<Contracts.Result<O>>;
  }
  export interface InstalledStepHandler {
    readonly id: string;
    readonly version: number;
    readonly localBinding: unknown;
  }
  export interface HandlerFactory {
    install<I extends Contracts.Json, O extends Contracts.Json>(
      handler: StepHandler<I, O>,
    ): InstalledStepHandler;
  }
  /** Declared by pipeline-v1; no other engine has to understand these steps. */
  export interface Extensions {
    readonly handlers: Composition.ExtensionPoint<InstalledStepHandler>;
  }
  export interface Definition {
    readonly format: 'part.pipeline';
    readonly version: 1;
    readonly id: string;
    readonly input: Contracts.SchemaRef;
    readonly output: Contracts.SchemaRef;
    readonly steps: readonly Step[];
    readonly result: Value;
  }
}

/** Optional trace/inspection module; minimal operation metadata still exists without it. */
export namespace Observability {
  export interface TracePolicy {
    readonly mode: 'none' | 'metadata' | 'redacted' | 'full';
    readonly destinations: readonly string[];
    readonly retentionMs?: number;
    readonly captureRequestBody: boolean;
    readonly captureToolOutput: boolean;
  }
  export interface InvocationManifest {
    readonly execution: Contracts.EntityRef;
    readonly runtimeVersion: string;
    readonly composition: Composition.ResolvedComposition;
    readonly driver?: { readonly id: string; readonly version: string };
    readonly workflow?: { readonly ref: Workflows.ExecutionRef; readonly definitionDigest: string };
    readonly profileRevisions: Readonly<Record<string, string>>;
    readonly contentDigests: Readonly<Record<string, string>>;
    readonly contextIds: readonly string[];
    readonly requestIds: readonly string[];
    readonly operationIds: readonly string[];
    readonly tracePolicy: TracePolicy;
    readonly guarantees: Contracts.CapabilitySet;
  }
  export interface Service {
    manifest(
      ref: Contracts.EntityRef,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<InvocationManifest>>;
    readTrace(
      ref: Contracts.EntityRef,
      cursor: string | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Page<Contracts.Json>>>;
  }
}
