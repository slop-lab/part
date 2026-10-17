// @ts-check
import { connectAcpMcpServers } from '@slop-lab/part-node/acp/mcp.js';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * Connect an already-built local toolset checkout, or an explicitly configured published command.
 * This never installs dependencies, builds a checkout, starts DIM, or starts proprietary services.
 * Router4u remains ordinary API-origin configuration supplied elsewhere by the host.
 *
 * @param {{
 *   root: string,
 *   allowedTools: readonly string[],
 *   checkout?: string,
 *   executable?: string,
 *   executableArgs?: readonly string[],
 *   path?: string,
 *   statePath?: string,
 *   profile?: 'p0'|'p1',
 *   signal?: AbortSignal,
 *   requestTimeoutMs?: number,
 *   maxTools?: number,
 *   connect?: typeof connectAcpMcpServers,
 * }} options
 */
export async function connectLocalToolsetCheckout(options) {
  if (!isAbsolute(options.root) || options.root.includes('\0'))
    throw new TypeError('Toolset root must be absolute');
  if (new Set(options.allowedTools).size !== options.allowedTools.length)
    throw new TypeError('Toolset allowlist contains duplicates');
  if (options.allowedTools.some((tool) => !tool || tool.includes('\0')))
    throw new TypeError('Toolset allowlist contains an invalid ID');
  if (options.statePath && options.statePath !== ':memory:' && !isAbsolute(options.statePath))
    throw new TypeError('Toolset state must be an absolute path or :memory:');

  let executable = options.executable ?? process.execPath;
  let args = options.executableArgs;
  if (args === undefined) {
    if (!options.checkout || !isAbsolute(options.checkout) || options.checkout.includes('\0'))
      throw new TypeError(
        'An absolute toolset checkout or explicit command arguments are required',
      );
    const entry = join(options.checkout, 'dist', 'mcp.js');
    let metadata;
    try {
      metadata = await stat(entry);
    } catch (error) {
      if (error instanceof Error)
        throw new TypeError('Toolset built MCP entry does not exist', { cause: error });
      throw error;
    }
    if (!metadata.isFile()) throw new TypeError('Toolset built MCP entry must be a file');
    args = [entry];
  }
  if (!isAbsolute(executable) || executable.includes('\0'))
    throw new TypeError('Toolset executable must be absolute');
  if (args.some((argument) => argument.includes('\0')))
    throw new TypeError('Toolset executable arguments contain NUL');

  const server = {
    name: 'agent_tools',
    command: executable,
    args: [...args],
    env: [
      { name: 'AGENT_TOOL_ROOT', value: options.root },
      { name: 'AGENT_TOOL_ALLOWED_TOOLS', value: JSON.stringify(options.allowedTools) },
      { name: 'AGENT_TOOL_PRINCIPAL', value: 'part-car' },
      { name: 'AGENT_TOOL_WORKSPACE', value: 'local' },
      { name: 'AGENT_TOOL_STATE', value: options.statePath ?? ':memory:' },
      { name: 'AGENT_TOOL_PROFILE', value: options.profile ?? 'p0' },
    ],
  };
  const connect = options.connect ?? connectAcpMcpServers;
  return connect({
    cwd: options.root,
    mcpServers: [server],
    environment: { PATH: options.path ?? process.env.PATH ?? '/usr/bin:/bin' },
    allowServer: (candidate) =>
      candidate.name === server.name &&
      candidate.command === server.command &&
      JSON.stringify(candidate.args) === JSON.stringify(server.args) &&
      JSON.stringify(candidate.env) === JSON.stringify(server.env),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxTools === undefined ? {} : { maxTools: options.maxTools }),
  });
}
