import type { Composition } from './composition.js';
import type { Contracts } from './contracts.js';
import type { Model } from './model.js';
import type { Packages } from './packages.js';
import type { Results } from './results.js';
import type { Runtime } from './runtime.js';
import type { Scripts } from './scripts.js';
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
