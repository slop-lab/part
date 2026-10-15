import type { Contracts, Tools } from '@slop-lab/part/reference';

export interface AcpMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { name: string; value: string }[];
}
export interface AcpMcpOptions {
  readonly cwd: string;
  readonly mcpServers: readonly AcpMcpServer[];
  readonly signal?: AbortSignal;
  readonly allowServer: (server: AcpMcpServer) => boolean | Promise<boolean>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxTools?: number;
}
export interface AcpMcpTools {
  readonly tools: readonly Tools.InstalledTool[];
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>;
  readonly executors: readonly Tools.Executor[];
  close(): Promise<Contracts.CleanupReport>;
}
