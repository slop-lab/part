import type { Contracts } from './contracts.js';
import type { Host } from './host.js';
import type { Model } from './model.js';
import type { Runtime } from './runtime.js';
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
