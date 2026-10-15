import type { Composition } from './composition.js';
import type { Context } from './context.js';
import type { Contracts } from './contracts.js';
import type { Packages } from './packages.js';
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
