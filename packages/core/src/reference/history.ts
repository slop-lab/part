import type { Contracts } from './contracts.js';
export namespace History {
  export interface Record<T = Contracts.Json> {
    readonly id: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly payload: T;
    readonly provenance: Contracts.Provenance;
    readonly visibility: {
      readonly model: boolean;
      readonly conversation: boolean;
      readonly inspector: boolean;
      readonly export: boolean;
    };
    readonly createdAt: Contracts.Timestamp;
  }
  export interface Branch {
    readonly id: string;
    readonly sessionId: string;
    readonly head?: string;
    readonly revision: Contracts.Revision;
  }
  export interface Entry {
    readonly entryId: string;
    readonly previous?: string;
    readonly record: Record;
  }
  export interface Service {
    createSession(
      metadata: Contracts.Json,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.EntityRef>>;
    fork(
      branch: Branch,
      atEntry: string | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Branch>>;
    append(
      branch: Branch,
      records: readonly Record[],
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Branch>>;
    path(
      branch: Branch,
      cursor: string | undefined,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Page<Entry>>>;
  }
}
