import type { Contracts } from './contracts.js';
/** A content package is NOT a loaded runtime extension. All loading remains opt-in. */
export namespace Packages {
  export interface Asset {
    readonly path: string;
    readonly digest: string;
    readonly mediaType: string;
    readonly bytes?: number;
  }
  export interface Snapshot {
    readonly id: string;
    readonly version?: string;
    readonly digest: string;
    readonly assets: readonly Asset[];
    readonly origin: string;
    readonly trustProfile: string;
  }
  export interface Source {
    discover(
      roots: readonly string[],
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly Snapshot[]>>;
    read(
      snapshot: Snapshot,
      path: string,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Uint8Array>>;
  }
  export interface UnsupportedField {
    readonly path: string;
    readonly significance: 'presentation' | 'optional' | 'required-behavior';
    readonly reason: string;
  }
  export interface CompatibilityReport {
    readonly format: string;
    readonly sourceVersion: string;
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly status: 'exact-tested-subset' | 'partial' | 'unsupported';
    readonly ignored: readonly UnsupportedField[];
    readonly semantics: readonly string[];
  }
  export interface Decoder<T> {
    readonly id: string;
    readonly format: string;
    decode(
      snapshot: Snapshot,
      source: Source,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<{ readonly value: T; readonly report: CompatibilityReport }>>;
  }
}
