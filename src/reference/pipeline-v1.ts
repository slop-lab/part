import type { Composition } from './composition.js';
import type { Contracts } from './contracts.js';
import type { Scripts } from './scripts.js';
import type { Workflows } from './workflows.js';
/** A proposed, limited pipeline format owned solely by workflow-pipeline-v1. */
export namespace PipelineV1 {
  export type Value =
    | { readonly literal: Contracts.Json }
    | { readonly input: string }
    | { readonly step: string; readonly pointer: string };
  export interface BaseStep {
    readonly id: string;
    readonly after: readonly string[];
    readonly timeoutMs?: number;
  }
  export type Step =
    | (BaseStep & {
        readonly kind: 'extension';
        readonly handler: string;
        readonly handlerVersion: number;
        readonly input: Value;
        readonly config: Contracts.Json;
      })
    | (BaseStep & {
        readonly kind: 'script';
        readonly request: Scripts.Request;
        readonly stdin: Value;
      })
    | (BaseStep & {
        readonly kind: 'agent';
        readonly profile: string;
        readonly input: Value;
        readonly skills?: readonly { readonly id: string; readonly digest: string }[];
      })
    | (BaseStep & {
        readonly kind: 'validate';
        readonly value: Value;
        readonly schema: Contracts.SchemaRef;
      })
    | (BaseStep & {
        readonly kind: 'wait';
        readonly response: Contracts.SchemaRef;
        readonly binding: Value;
        readonly prompt: string;
      })
    | (BaseStep & {
        readonly kind: 'assert';
        readonly value: Value;
        readonly equals: Contracts.Json;
      })
    | (BaseStep & {
        readonly kind: 'branch';
        readonly value: Value;
        readonly cases: readonly {
          readonly equals: Contracts.Json;
          readonly run: readonly Step[];
        }[];
        readonly otherwise?: readonly Step[];
      })
    | (BaseStep & {
        readonly kind: 'repeat';
        readonly maxIterations: number;
        readonly body: readonly Step[];
        readonly until: { readonly value: Value; readonly equals: Contracts.Json };
      })
    | (BaseStep & {
        readonly kind: 'parallel';
        readonly maxConcurrency: number;
        readonly onError: 'cancel-and-join' | 'collect';
        readonly branches: readonly (readonly Step[])[];
      });
  export interface StepHandler<I extends Contracts.Json, O extends Contracts.Json> {
    readonly id: string;
    readonly version: number;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    readonly config: Contracts.Schema<Contracts.Json>;
    readonly requires: readonly string[];
    readonly effects: 'read' | 'write' | 'external' | 'unknown';
    readonly replay: 'never' | 'idempotent-with-key' | 'engine-managed';
    execute(
      input: I,
      config: Contracts.Json,
      identity: Workflows.CallIdentity,
      context: Workflows.StepContext,
    ): Promise<Contracts.Result<O>>;
  }
  export interface InstalledStepHandler {
    readonly id: string;
    readonly version: number;
    readonly localBinding: unknown;
  }
  export interface HandlerFactory {
    install<I extends Contracts.Json, O extends Contracts.Json>(
      handler: StepHandler<I, O>,
    ): InstalledStepHandler;
  }
  /** Declared by pipeline-v1; no other engine has to understand these steps. */
  export interface Extensions {
    readonly handlers: Composition.ExtensionPoint<InstalledStepHandler>;
  }
  export interface Definition {
    readonly format: 'part.pipeline';
    readonly version: 1;
    readonly id: string;
    readonly input: Contracts.SchemaRef;
    readonly output: Contracts.SchemaRef;
    readonly steps: readonly Step[];
    readonly result: Value;
  }
}
