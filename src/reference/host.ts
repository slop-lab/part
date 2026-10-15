import type { Contracts } from './contracts.js';
import type { Runtime } from './runtime.js';
export namespace Host {
  export interface AdmissionRequest<I = Contracts.Json> {
    readonly requestId: string;
    readonly run: Runtime.RunRequest<I>;
    readonly concurrencyKey?: string;
    readonly priority?: number;
    readonly expiresAt?: string;
  }
  export type Admission =
    | { readonly kind: 'started'; readonly run: Contracts.EntityRef }
    | { readonly kind: 'queued'; readonly job: Contracts.EntityRef }
    | { readonly kind: 'superseded'; readonly by: string }
    | { readonly kind: 'rejected'; readonly error: Contracts.Failure };
  export interface Service {
    start(context: Contracts.InvocationContext): Promise<Contracts.Result<void>>;
    submit(
      request: AdmissionRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Admission>>;
    stop(options: {
      readonly mode: 'drain' | 'cancel';
      readonly deadline?: string;
    }): Promise<Contracts.CleanupReport>;
  }
  export interface InputPolicy {
    decide(
      request: AdmissionRequest,
      pending: readonly AdmissionRequest[],
    ): Contracts.Result<{
      readonly action: 'start' | 'queue' | 'replace-pending' | 'reject';
      readonly affected: readonly string[];
    }>;
  }
  export interface RuntimeResource {
    readonly ref: Contracts.ResourceRef;
    readonly owner: Contracts.ScopeRef;
    readonly transferable: boolean;
    close(reason: string): Promise<Contracts.Result<void>>;
  }
  export interface ResourceManager {
    register(resource: RuntimeResource): Contracts.Result<Contracts.ResourceRef>;
    transfer(ref: Contracts.ResourceRef, target: Contracts.ScopeRef): Contracts.Result<void>;
    closeOwner(owner: Contracts.ScopeRef): Promise<Contracts.CleanupReport>;
  }
}
