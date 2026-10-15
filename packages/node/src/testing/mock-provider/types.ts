import type { Contracts } from '@slop-lab/part/reference';

export interface MockProject {
  readonly id: string;
  readonly root?: string;
  readonly scenario?: string;
}
export type MockChatRequest = Readonly<Record<string, Contracts.Json>> & {
  readonly model: string;
  readonly messages: readonly Contracts.Json[];
  readonly stream?: boolean;
};
export interface MockToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}
export type MockReply =
  | {
      readonly kind: 'completion';
      readonly content: string | null;
      readonly toolCalls?: readonly MockToolCall[];
      readonly finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
      readonly textChunks?: readonly string[];
      readonly usage?: {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
        readonly total_tokens: number;
      };
    }
  | {
      readonly kind: 'error';
      readonly status: number;
      readonly message: string;
      readonly code?: string;
    }
  | {
      readonly kind: 'raw';
      readonly status: number;
      readonly contentType: string;
      readonly body: string;
    };
export interface MockFixture {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly exchanges: readonly {
    readonly id: string;
    readonly request: MockChatRequest;
    readonly reply: MockReply;
  }[];
}
export interface MockSession {
  readonly schemaVersion: 1;
  readonly mode: 'interactive' | 'fixed';
  readonly project: MockProject;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly controlURL: string;
  readonly controlToken: string;
}
export interface MockRequestRecord {
  readonly id: string;
  readonly project: MockProject;
  readonly request: MockChatRequest;
  readonly state: 'pending' | 'responded' | 'cancelled' | 'timed-out' | 'closed' | 'mismatched';
  readonly fixtureId?: string;
  readonly reply?: MockReply;
  readonly decisionId?: string;
}
export interface MockTranscript {
  readonly schemaVersion: 1;
  readonly mode: 'interactive' | 'fixed';
  readonly project: MockProject;
  readonly requests: readonly MockRequestRecord[];
  readonly failures: readonly string[];
  readonly remaining: number;
}
export interface MockStatus {
  readonly mode: 'interactive' | 'fixed';
  readonly project: MockProject;
  readonly pending: number;
  readonly received: number;
  readonly remaining: number;
  readonly failures: readonly string[];
}
export interface MockProviderClient {
  status(): Promise<MockStatus>;
  pending(waitMs?: number, signal?: AbortSignal): Promise<readonly MockRequestRecord[]>;
  inspect(id: string): Promise<MockRequestRecord>;
  respond(id: string, decisionId: string, reply: MockReply): Promise<MockRequestRecord>;
  transcript(): Promise<MockTranscript>;
  verify(): Promise<void>;
}
