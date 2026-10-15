import type { Contracts } from './contracts.js';
import type { Results } from './results.js';
import type { Runtime } from './runtime.js';
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
