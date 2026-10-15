import type { Contracts } from './contracts.js';
import type { Model } from './model.js';
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
