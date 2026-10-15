import type { Contracts, Tools } from '@part/core/reference';
import type { AgentOptions } from '../agent/index.js';

/** Structural peer port, implemented by @part/node/acp or a host's ACP SDK binding. */
export interface AcpConnection {
  notify(method: string, params: Contracts.Json): Promise<void>;
  request(
    method: string,
    params: Contracts.Json,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Contracts.Json>;
}
export interface AcpSessionSetup {
  readonly sessionId: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly mcpServers: readonly AcpMcpServer[];
  readonly clientCapabilities: Readonly<Record<string, Contracts.Json>>;
}
export interface AcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { name: string; value: string }[];
}
export interface AcpMcpTools {
  readonly tools: readonly Tools.InstalledTool[];
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>;
  readonly executors: readonly Tools.Executor[];
  close(): Promise<Contracts.CleanupReport>;
}
export interface AcpAgentOptions {
  readonly connection: AcpConnection;
  readonly configureSession: (setup: AcpSessionSetup) => AgentOptions | Promise<AgentOptions>;
  readonly connectMcp?: (setup: AcpSessionSetup) => Promise<AcpMcpTools>;
  readonly agentInfo?: { name: string; version: string; title?: string };
  readonly permissions?: 'writes' | 'all';
  readonly maxSessions?: number;
  readonly maxHistoryTurns?: number;
  readonly maxPromptBytes?: number;
  readonly turnTimeoutMs?: number;
}
export interface AcpAgent {
  handle(
    method: string,
    params: Contracts.Json,
    kind?: 'request' | 'notification',
    signal?: AbortSignal,
  ): Promise<Contracts.Json>;
  close(): Promise<Contracts.CleanupReport>;
}
export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Contracts.Json,
    readonly cleanup?: Contracts.CleanupReport,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}
