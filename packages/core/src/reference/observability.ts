import type { Composition } from './composition.js';
import type { Contracts } from './contracts.js';
import type { Workflows } from './workflows.js';
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
