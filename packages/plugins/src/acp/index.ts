import { version } from '../version.js';
import { emptyCleanup, isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { Contracts } from '@slop-lab/part/reference/index.js';
import { mcpServers, positiveLimit, sessionParams } from './content.js';
import { createAcpSession } from './session.js';
import { AcpError } from './types.js';
import type { AcpAgent, AcpAgentOptions } from './types.js';
export { AcpError } from './types.js';
export type {
  AcpAgent,
  AcpAgentOptions,
  AcpConnection,
  AcpSessionSetup,
  AcpMcpServer,
  AcpMcpTools,
} from './types.js';

/** ACP v1 agent profile. Installs permission middleware in every configured session. */
export function createAcpAgent(options: AcpAgentOptions): AcpAgent {
  const limits = {
    maxHistoryTurns: positiveLimit(options.maxHistoryTurns, 32, 'maxHistoryTurns'),
    maxPromptBytes: positiveLimit(options.maxPromptBytes, 256 * 1024, 'maxPromptBytes'),
    turnTimeoutMs: positiveLimit(options.turnTimeoutMs, 180000, 'turnTimeoutMs'),
  };
  const orphaned: Contracts.CleanupReport[] = [];
  const maxSessions = positiveLimit(options.maxSessions, 16, 'maxSessions');
  if (options.permissions !== undefined && !['writes', 'all'].includes(options.permissions))
    throw new TypeError('Invalid permission policy');
  const sessions = new Map<string, Awaited<ReturnType<typeof createAcpSession>>>(),
    creating = new Set<Promise<unknown>>();
  const connectionAbort = new AbortController();
  let initialized = false,
    closed = false,
    clientCapabilities: Record<string, Contracts.Json> = {},
    disposing: Promise<Contracts.CleanupReport> | undefined;
  return {
    async handle(method, params, kind = 'request', signal) {
      if (closed) throw new AcpError(-32600, 'ACP connection is closed');
      if (method === 'session/cancel' && kind === 'notification') {
        const request = sessionParams(params);
        sessions.get(request.sessionId)?.cancel();
        return null;
      }
      if (kind !== 'request') return null;
      if (method === 'initialize') {
        if (
          initialized ||
          !isJsonObject(params) ||
          !Number.isSafeInteger(params.protocolVersion) ||
          Number(params.protocolVersion) < 1 ||
          (params.clientCapabilities !== undefined && !isJsonObject(params.clientCapabilities))
        )
          throw new AcpError(-32602, 'Invalid or repeated initialization');
        clientCapabilities = isJsonObject(params.clientCapabilities)
          ? structuredClone(params.clientCapabilities)
          : {};
        initialized = true;
        return {
          protocolVersion: 1,
          agentInfo: options.agentInfo ?? {
            name: 'part',
            version,
            title: 'Progressive agent runtime',
          },
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: { close: {} },
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
          },
          authMethods: [],
        };
      }
      if (!initialized) throw new AcpError(-32600, 'Initialize before using sessions');
      if (method === 'session/new') {
        if (
          !isJsonObject(params) ||
          typeof params.cwd !== 'string' ||
          params.cwd.length > 4096 ||
          params.cwd.includes('\0') ||
          !/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(params.cwd) ||
          !Array.isArray(params.mcpServers) ||
          (params.additionalDirectories !== undefined &&
            (!Array.isArray(params.additionalDirectories) ||
              params.additionalDirectories.length > 0))
        )
          throw new AcpError(-32602, 'An absolute cwd and no additional directories are required');
        if (sessions.size + creating.size >= maxSessions)
          throw new AcpError(-32000, 'Session capacity reached');
        const servers = mcpServers(params.mcpServers ?? null);
        if (servers.length && !options.connectMcp)
          throw new AcpError(-32602, 'No host MCP connector is installed');
        const sessionId = crypto.randomUUID(),
          sessionAbort = new AbortController();
        const cancelSetup = () => sessionAbort.abort();
        signal?.addEventListener('abort', cancelSetup, { once: true });
        if (signal?.aborted) cancelSetup();
        const pending = (async () => {
          const session = await createAcpSession(
            {
              sessionId,
              mcpServers: servers,
              cwd: params.cwd as string,
              signal: AbortSignal.any([connectionAbort.signal, sessionAbort.signal]),
              clientCapabilities: structuredClone(clientCapabilities),
            },
            { ...options, ...limits },
          );
          const owned = {
            ...session,
            close() {
              session.cancel();
              sessionAbort.abort();
              return session.close();
            },
          };
          if (closed || signal?.aborted) {
            const cleanup = await owned.close();
            throw new AcpError(
              signal?.aborted ? -32800 : -32600,
              'Connection closed during session creation',
              undefined,
              cleanup,
            );
          }
          sessions.set(sessionId, owned);
          return { sessionId };
        })();
        creating.add(pending);
        try {
          return await pending;
        } catch (error) {
          sessionAbort.abort();
          if (error && typeof error === 'object' && 'cleanup' in error) {
            const report = error.cleanup;
            if (
              isJsonObject(report) &&
              Array.isArray(report.released) &&
              Array.isArray(report.unresolved) &&
              Array.isArray(report.errors)
            )
              orphaned.push(report as unknown as Contracts.CleanupReport);
          }
          if (error instanceof AcpError) throw error;
          throw new AcpError(-32603, 'Session configuration failed');
        } finally {
          signal?.removeEventListener('abort', cancelSetup);
          creating.delete(pending);
        }
      }
      if (method === 'session/close') {
        const request = sessionParams(params),
          session = sessions.get(request.sessionId);
        if (!session) throw new AcpError(-32602, 'Unknown session');
        const report = await session.close();
        if (report.unresolved.length || report.errors.length)
          throw new AcpError(-32603, 'Session cleanup incomplete', {
            unresolved: report.unresolved.length,
            errors: report.errors.length,
          });
        sessions.delete(request.sessionId);
        return {};
      }
      if (method === 'session/prompt') {
        const request = sessionParams(params),
          session = sessions.get(request.sessionId);
        if (!session) throw new AcpError(-32602, 'Unknown session');
        return session.prompt(request.prompt ?? null, signal);
      }
      throw new AcpError(-32601, 'Method not supported by this ACP profile');
    },
    close() {
      return (disposing ??= (async () => {
        closed = true;
        for (const session of sessions.values()) session.cancel();
        connectionAbort.abort();
        await Promise.allSettled([...creating]);
        const reports = [
          ...orphaned,
          ...(await Promise.all([...sessions.values()].map((session) => session.close()))),
        ];
        sessions.clear();
        return reports.reduce(
          (all, report) => ({
            released: [...all.released, ...report.released],
            unresolved: [...all.unresolved, ...report.unresolved],
            errors: [...all.errors, ...report.errors],
          }),
          emptyCleanup(),
        );
      })());
    },
  };
}
