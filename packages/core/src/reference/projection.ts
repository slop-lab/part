import type { Contracts } from './contracts.js';
export namespace Projection {
  export interface Audience {
    readonly target: 'chat' | 'inspector' | 'document' | 'overlay' | 'export' | string;
    readonly authorizationRevision: string;
  }
  export interface SafeFallback {
    readonly label: string;
    readonly text?: string;
    readonly detail?: Contracts.Json;
  }
  export interface Item<T = Contracts.Json> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly revision: string;
    readonly source?: Contracts.EntityRef;
    readonly payload: T;
    readonly fallback: SafeFallback;
    readonly actions: readonly Contracts.ActionDescriptor[];
    readonly artifacts: readonly Contracts.ArtifactRef[];
  }
  export interface Projector<T> {
    readonly id: string;
    project(
      value: T,
      audience: Audience,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Item[]>>;
  }
  export interface Service {
    read(
      target: Contracts.EntityRef,
      audience: Audience,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Item[]>>;
  }
}
