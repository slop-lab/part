import type { Composition } from './composition.js';
import type { Context } from './context.js';
import type { Contracts } from './contracts.js';
import type { Model } from './model.js';
import type { Runtime } from './runtime.js';
import type { Tools } from './tools.js';
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
