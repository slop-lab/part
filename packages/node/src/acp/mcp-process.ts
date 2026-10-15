import { emptyCleanup, fail } from '@part/core/contracts';
import type { Contracts } from '@part/core/reference';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { isAbsolute } from 'node:path';
import { startJsonRpcPeer } from './peer.js';
import type { AcpPeer } from './types.js';
import type { AcpMcpOptions, AcpMcpServer } from './mcp-types.js';

export async function startMcpProcess(server: AcpMcpServer, options: AcpMcpOptions) {
  if (
    !isAbsolute(server.command) ||
    !isAbsolute(options.cwd) ||
    server.command.includes('\0') ||
    !server.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    !server.env.every(
      (entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) && !entry.value.includes('\0'),
    ) ||
    new Set(server.env.map((entry) => entry.name)).size !== server.env.length ||
    options.signal?.aborted ||
    !(await options.allowServer(server))
  )
    throw Error('MCP server launch was not authorized or its configuration was invalid');
  if (options.signal?.aborted) throw Error('MCP session cancelled before launch');
  const child = spawn(server.command, [...server.args], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...options.environment,
      ...Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let exited = false,
    peer!: AcpPeer,
    stderrBytes = 0,
    closing: Promise<Contracts.CleanupReport> | undefined;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });
  const rpc = startJsonRpcPeer({
    cancelMethod: 'notifications/cancelled',
    input: child.stdout,
    output: child.stdin,
    requestTimeoutMs: options.requestTimeoutMs,
    createHandler(connection) {
      peer = connection;
      return {
        async handle(method, _params, kind) {
          if (kind === 'notification') return null;
          if (method === 'ping') return {};
          throw Object.assign(Error('MCP client method not supported'), { code: -32601 });
        },
        async close() {
          return emptyCleanup();
        },
      };
    },
  });
  const signal = (kind: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind);
      else if (!exited) child.kill(kind);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
        return false;
    }
    return true;
  };
  const close = (): Promise<Contracts.CleanupReport> =>
    (closing ??= (async () => {
      options.signal?.removeEventListener('abort', cancelled);
      await rpc.close();
      child.stdin.end();
      await Promise.race([exit, setTimeout(100)]);
      const term = signal('SIGTERM');
      await Promise.race([exit, setTimeout(150)]);
      const killed = signal('SIGKILL');
      await Promise.race([exit, setTimeout(150)]);
      let alive = !exited;
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 0);
          alive = true;
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
            alive = false;
        }
      }
      const ref = { owner: 'part/acp-mcp', kind: 'process', id: String(child.pid ?? server.name) };
      child.stdout.destroy();
      child.stderr.destroy();
      return {
        released: alive ? [] : [ref],
        unresolved: alive ? [ref] : [],
        errors:
          term && killed
            ? []
            : [fail('acp.mcp-cleanup', 'MCP process signal failed', 'unavailable').error],
      };
    })());
  const cancelled = () => {
    void close();
  };
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) void close();
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 256 * 1024) void close();
  });
  void rpc.closed.then(() => {
    if (!closing) void close();
  });
  return { peer, close, exited: () => exited };
}
