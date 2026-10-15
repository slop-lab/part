import type { Contracts } from './contracts.js';
/** Optional neutral result transport/validation module. No implicit business actions. */
export namespace Results {
  export interface TypeDefinition<T> {
    readonly id: string;
    readonly version: number;
    readonly schema: Contracts.Schema<T>;
    readonly mediaType: string;
  }
  export type Input =
    | { readonly kind: 'inline'; readonly value: Contracts.Json }
    | {
        readonly kind: 'artifact';
        readonly ref: Contracts.ArtifactRef;
        readonly expectedDigest: string;
      }
    | { readonly kind: 'captured'; readonly captureId: string; readonly expectedDigest: string };
  export interface Validation {
    readonly validator: string;
    readonly version: string;
    readonly inputDigest: string;
    readonly outputDigest?: string;
    readonly status: 'pass' | 'fail';
    readonly diagnostics: readonly Contracts.Issue[];
  }
  export interface Accepted {
    readonly id: string;
    readonly type: Contracts.SchemaRef;
    readonly data: Input;
    readonly digest: string;
    readonly producedBy: Contracts.EntityRef;
    readonly definitionDigest?: string;
    readonly validation: readonly Validation[];
    readonly provenance: Contracts.Provenance;
    readonly commit: readonly Contracts.CommitEvidence[];
  }
  export interface Submission {
    readonly submissionId: string;
    readonly expectedType: Contracts.SchemaRef;
    readonly data: Input;
    readonly producedBy: Contracts.EntityRef;
    readonly validationProfile: string;
  }
  export interface Processor {
    readonly id: string;
    readonly version: string;
    readonly inputType: Contracts.SchemaRef;
    readonly outputType: Contracts.SchemaRef;
    process(
      input: Input,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<{ readonly output: Input; readonly evidence: Validation }>>;
  }
  export interface Service {
    submit(
      input: Submission,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Accepted>>;
    read(id: string, context: Contracts.InvocationContext): Promise<Contracts.Result<Accepted>>;
  }
}
