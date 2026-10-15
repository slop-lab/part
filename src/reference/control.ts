import type { Contracts } from './contracts.js';
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
