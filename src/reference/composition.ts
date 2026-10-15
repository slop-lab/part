import type { Contracts } from './contracts.js';
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
