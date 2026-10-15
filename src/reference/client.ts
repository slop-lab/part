import type { Contracts } from './contracts.js';
import type { Projection } from './projection.js';
export namespace Client {
  export type CommandDelivery<O = Contracts.Json> =
    | { readonly kind: 'not-sent'; readonly commandId: string; readonly error: Contracts.Failure }
    | { readonly kind: 'receipt'; readonly receipt: Contracts.CommandReceipt<O> }
    | {
        readonly kind: 'unknown';
        readonly commandId: string;
        readonly error: Contracts.Failure;
        readonly recovery: 'query-status' | 'same-key-retry' | 'manual';
      };
  export interface StreamPartSnapshot {
    readonly itemId: string;
    readonly partId: string;
    readonly generation: string;
    readonly text: string;
    readonly offset: number;
    readonly completed: boolean;
  }
  export interface TextDelta {
    readonly itemId: string;
    readonly partId: string;
    readonly generation: string;
    readonly offset: number;
    readonly text: string;
  }
  export interface QueryBinding<I, O> {
    readonly id: string;
    readonly version: number;
    readonly input: Contracts.Schema<I>;
    readonly output: Contracts.Schema<O>;
    read(input: I, context: Contracts.InvocationContext): Promise<Contracts.Result<O>>;
  }
  export interface Endpoint {
    command(
      request: Contracts.CommandRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.CommandReceipt>;
    query(
      request: Contracts.QueryRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Json>>;
    watch(
      request: WatchRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<WatchSession>>;
  }
  export interface EventEnvelope<T = Contracts.Json> {
    readonly protocolVersion: number;
    readonly epoch: string;
    readonly streamId: string;
    readonly sequence: number;
    readonly cursor: string;
    readonly type: string;
    readonly schemaVersion: number;
    readonly persistence: 'state-backed' | 'delta' | 'ephemeral';
    readonly causationId?: string;
    readonly correlationId?: string;
    readonly runId?: string;
    readonly operationId?: string;
    readonly payload: T;
  }
  export interface Snapshot {
    readonly epoch: string;
    readonly streamId: string;
    readonly throughSequence: number;
    readonly cursor: string;
    readonly audienceRevision: string;
    readonly items: readonly Projection.Item[];
    readonly streamingParts: readonly StreamPartSnapshot[];
    readonly capabilities: Contracts.CapabilitySet;
  }
  export type StreamFrame =
    | { readonly kind: 'event'; readonly event: EventEnvelope }
    | { readonly kind: 'reset'; readonly snapshot: Snapshot }
    | {
        readonly kind: 'gap';
        readonly recovery: 'replay' | 'snapshot' | 'unavailable';
        readonly lastCursor?: string;
        readonly reason: string;
      };
  export interface WatchRequest {
    readonly target?: Contracts.EntityRef;
    readonly surface: string;
    readonly resumeCursor?: string;
  }
  export interface WatchSession {
    readonly bootstrap: Snapshot;
    readonly frames: AsyncIterable<StreamFrame>;
    close(): Promise<void>;
  }
  export interface Port {
    command(
      request: Contracts.CommandRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<CommandDelivery>;
    query(
      request: Contracts.QueryRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Contracts.Result<Contracts.Json>>;
    discover(target?: Contracts.EntityRef): Promise<Contracts.Result<Contracts.CapabilitySet>>;
    watch(
      request: WatchRequest,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Contracts.Result<WatchSession>>;
  }
  export interface State {
    readonly epoch?: string;
    readonly connection: 'offline' | 'connecting' | 'connected' | 'resyncing';
    readonly itemIds: readonly string[];
    readonly pendingCommands: readonly string[];
  }
  export interface Selector<T> {
    select(state: State, getItem: (id: string) => Projection.Item | undefined): T;
    equal(left: T, right: T): boolean;
  }
  export interface Controller {
    readonly port: Port;
    getState(): State;
    getItem(id: string): Projection.Item | undefined;
    subscribe<T>(selector: Selector<T>, listener: (next: T) => void): () => void;
    connect(request: WatchRequest): Promise<Contracts.Result<void>>;
    disconnect(): Promise<void>;
    invoke(request: Contracts.CommandRequest): Promise<CommandDelivery>;
    dispose(): Promise<void>;
  }
  export interface Codec {
    encode(value: Contracts.Json): Contracts.Result<Uint8Array>;
    decode(bytes: Uint8Array): Contracts.Result<Contracts.Json>;
  }
}
