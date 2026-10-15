import type { Contracts } from './contracts.js';
import type { Scripts } from './scripts.js';
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
