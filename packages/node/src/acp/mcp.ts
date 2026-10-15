import { digest, fail, isJsonObject, schema } from '@slop-lab/part/contracts';
import type { Contracts, Model, Runtime, Tools } from '@slop-lab/part/reference';
import { reserve } from '@slop-lab/part/runtime';
import { installTool } from '@slop-lab/part/tools';
import { startMcpProcess } from './mcp-process.js';
import { limit } from './types.js';
import type { AcpMcpOptions, AcpMcpTools } from './mcp-types.js';
export type { AcpMcpOptions, AcpMcpTools, AcpMcpServer } from './mcp-types.js';

/** Session-owned stdio MCP tools; client-supplied commands require a host allow decision. */
export async function connectAcpMcpServers(options: AcpMcpOptions): Promise<AcpMcpTools> {
  const maxTools = limit(options.maxTools, 64);
  options = { ...options, requestTimeoutMs: limit(options.requestTimeoutMs, 120000) };
  if (options.mcpServers.length > 8) throw Error('Too many MCP servers');
  const processes: Awaited<ReturnType<typeof startMcpProcess>>[] = [],
    tools: Tools.InstalledTool[] = [],
    toolSchemas: Record<string, Contracts.Json> = {};
  const targets = new Map<
    string,
    { process: Awaited<ReturnType<typeof startMcpProcess>>; name: string }
  >();
  let closed = false,
    cleanup: Promise<Contracts.CleanupReport> | undefined;
  const close = () =>
    (cleanup ??= (async () => {
      closed = true;
      const reports = await Promise.all(processes.map((process) => process.close()));
      return {
        released: reports.flatMap((report) => report.released),
        unresolved: reports.flatMap((report) => report.unresolved),
        errors: reports.flatMap((report) => report.errors),
      };
    })());
  try {
    for (const [index, server] of options.mcpServers.entries()) {
      const process = await startMcpProcess(server, options);
      processes.push(process);
      const initialized = await process.peer.request(
        'initialize',
        {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'part', version: '0.1.0-alpha.2' },
          capabilities: {},
        },
        { signal: options.signal },
      );
      if (
        !isJsonObject(initialized) ||
        !['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(
          String(initialized.protocolVersion),
        ) ||
        !isJsonObject(initialized.capabilities)
      )
        throw Error('Unsupported MCP initialization');
      await process.peer.notify('notifications/initialized', {});
      if (!isJsonObject(initialized.capabilities.tools)) continue;
      let cursor: string | undefined;
      const cursors = new Set<string>(),
        names = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 32) throw Error('MCP tool pagination exceeds limit');
        const listed = await process.peer.request('tools/list', cursor ? { cursor } : {}, {
          signal: options.signal,
        });
        if (!isJsonObject(listed) || !Array.isArray(listed.tools))
          throw Error('Invalid MCP tool list');
        for (const definition of listed.tools) {
          if (
            tools.length >= maxTools ||
            !isJsonObject(definition) ||
            typeof definition.name !== 'string' ||
            !definition.name ||
            names.has(definition.name) ||
            !isJsonObject(definition.inputSchema) ||
            definition.inputSchema.type !== 'object'
          )
            throw Error('Invalid, duplicate or excessive MCP tools');
          names.add(definition.name);
          const id = `mcp_${index}_${names.size - 1}_${definition.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`;
          const description =
            typeof definition.description === 'string'
              ? definition.description.slice(0, 8192)
              : `${server.name}: ${definition.name}`;
          targets.set(id, { process, name: definition.name });
          toolSchemas[id] = definition.inputSchema;
          tools.push(
            installTool({
              definition: {
                id,
                version: '1',
                description,
                input: schema(`part/${id}/arguments`, isJsonObject),
                executor: 'part/acp-mcp',
                effects: 'external',
                cancellation: 'cooperative',
                retrySafety: 'never',
                requiredCapabilities: [],
              },
              async execute() {
                return fail('acp.mcp-binding', 'MCP tools require their installed executor');
              },
            }),
          );
        }
        if (listed.nextCursor === undefined || listed.nextCursor === null) break;
        if (
          typeof listed.nextCursor !== 'string' ||
          !listed.nextCursor ||
          cursors.has(listed.nextCursor)
        )
          throw Error('Invalid MCP pagination cursor');
        cursor = listed.nextCursor;
        cursors.add(cursor);
      }
    }
    const consumed = new WeakSet<Runtime.AttemptPermit>();
    const executor: Tools.Executor = {
      id: 'part/acp-mcp',
      capabilities: { revision: '1', entries: [] },
      async execute(plan, permit, context) {
        const failure = (
          code: string,
          message: string,
          effect: Contracts.EffectState = 'not-attempted',
        ): Runtime.AttemptOutcome<Tools.ResultContent> => ({
          kind: 'failed',
          effect,
          error: fail(code, message, 'unavailable', effect).error,
        });
        const target = targets.get(plan.definition.id);
        const expected: Runtime.EffectPlan = {
          operationId: context.operationId,
          attemptId: context.attemptId,
          target: plan.definition.id,
          executor: plan.executorId,
          inputDigest: plan.digest,
          scopeDigest: await digest({ principal: context.principal, scope: { ...context.scope } }),
          compositionRevision: plan.revision,
          classification: plan.definition.effects,
        };
        if (
          !target ||
          closed ||
          consumed.has(permit) ||
          permit.attemptId !== context.attemptId ||
          permit.planDigest !== (await digest(expected as unknown as Contracts.Json))
        )
          return failure('acp.mcp-permit', 'An unused matching dispatcher permit is required');
        consumed.add(permit);
        const budget = reserve(context, 'maxExecutorAttempts');
        if (!budget.ok) return { kind: 'failed', effect: 'not-attempted', error: budget.error };
        if (context.signal.aborted) return { kind: 'cancelled', effect: 'not-attempted' };
        try {
          const result = await target.process.peer.request(
            'tools/call',
            { name: target.name, arguments: plan.validatedArguments as Contracts.Json },
            { signal: context.signal },
          );
          if (!isJsonObject(result) || result.isError === true || !Array.isArray(result.content))
            return failure(
              'acp.mcp-result',
              'MCP call failed or returned invalid content',
              'unknown',
            );
          const content: Model.ContentPart[] = [];
          for (const part of result.content) {
            if (!isJsonObject(part) || part.type !== 'text' || typeof part.text !== 'string')
              return failure('acp.mcp-content', 'Only MCP text content is supported', 'unknown');
            content.push({ kind: 'text', text: part.text });
          }
          if (result.structuredContent !== undefined && !isJsonObject(result.structuredContent))
            return failure('acp.mcp-result', 'Invalid structured MCP output', 'unknown');
          return {
            kind: 'returned',
            effect: 'unknown',
            value: {
              content,
              ...(result.structuredContent !== undefined
                ? { value: result.structuredContent }
                : {}),
              artifacts: [],
              diagnostics: [],
            },
          };
        } catch {
          if (context.signal.aborted) await target.process.close();
          return failure('acp.mcp-call', 'MCP call failed or was cancelled', 'unknown');
        }
      },
    };
    return { tools, toolSchemas, executors: [executor], close };
  } catch {
    const cleanup = await close();
    throw Object.assign(Error('MCP session setup failed'), { cleanup });
  }
}
