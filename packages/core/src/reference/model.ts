import type { Context } from './context.js';
import type { Contracts } from './contracts.js';
import type { Runtime } from './runtime.js';
export namespace Model {
  export interface NativePart {
    readonly provider: Contracts.QualifiedId;
    readonly formatVersion: string;
    readonly affinity?: { readonly profile: string; readonly conversation?: string };
    readonly payload: Contracts.Json;
  }
  export type ContentPart =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'json'; readonly value: Contracts.Json }
    | {
        readonly kind: 'media';
        readonly mediaType: string;
        readonly artifact: Contracts.ArtifactRef;
      }
    | { readonly kind: 'native'; readonly native: NativePart };
  export interface ToolCall {
    readonly id: string;
    readonly toolId: string;
    readonly arguments: Contracts.Json;
    readonly native?: NativePart;
  }
  export interface Response {
    readonly content: readonly ContentPart[];
    readonly toolCalls: readonly ToolCall[];
    readonly finish: { readonly normalized: string; readonly native?: Contracts.Json };
    readonly usage: Runtime.Usage;
    readonly continuation?: NativePart;
  }
  export interface ToolAdvertisement {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: Contracts.Json;
    readonly execution: 'runtime' | 'provider';
    readonly version: string;
  }
  export interface Invocation {
    readonly profileId: string;
    readonly context: Context.CompiledContext;
    readonly tools: readonly ToolAdvertisement[];
    readonly options: Contracts.Json;
    readonly continuation?: NativePart;
  }
  export interface Gateway {
    invoke(
      request: Invocation,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Runtime.ExecutionHandle<Response>>>;
  }
  export interface Profile {
    readonly id: string;
    readonly revision: Contracts.Revision;
    readonly adapterId: string;
    readonly transportId: string;
    readonly authStrategyId: string;
    readonly model: string;
    readonly endpoint?: string;
    readonly defaults: Contracts.Json;
    readonly capabilities: Contracts.CapabilitySet;
  }
  export interface EncodedRequest {
    readonly protocol: string;
    readonly mediaType: string;
    readonly body: Uint8Array;
    readonly digest: Contracts.Digest;
    readonly metadata: Contracts.Json;
    readonly inspectionBoundary: 'outgoing-body' | 'broker-input';
  }
  export interface WireResponse {
    readonly status?: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: AsyncIterable<Uint8Array>;
  }
  export interface ProviderEvent {
    readonly type: string;
    readonly payload: Contracts.Json;
  }
  export interface ResponseDecoder {
    push(chunk: Uint8Array): Contracts.Result<readonly ProviderEvent[]>;
    finish(): Contracts.Result<Response>;
  }
  export interface Adapter {
    readonly id: string;
    encode(invocation: Invocation, profile: Profile): Promise<Contracts.Result<EncodedRequest>>;
    createDecoder(response: {
      readonly status?: number;
      readonly headers: Readonly<Record<string, string>>;
    }): Contracts.Result<ResponseDecoder>;
  }
  export interface CredentialBinding {
    readonly strategy: string;
    readonly material: unknown;
  }
  export interface AuthStrategy {
    bind(
      profile: Profile,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<CredentialBinding>>;
  }
  export interface Transport {
    readonly id: string;
    send(
      request: EncodedRequest,
      profile: Profile,
      auth: CredentialBinding,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<WireResponse>>;
  }
  export interface RequestTransform {
    readonly id: string;
    apply(
      request: EncodedRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<EncodedRequest>>;
  }
  export interface RequestInspection {
    readonly requestId: string;
    readonly contextId: string;
    readonly attemptId: string;
    readonly actualDigest: Contracts.Digest;
    readonly boundary: EncodedRequest['inspectionBoundary'];
    readonly publicPayload?: Contracts.Json;
    readonly redactions: readonly string[];
    readonly transportId: string;
  }
}
