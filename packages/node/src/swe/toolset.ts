import {
  fail,
  isJson,
  isJsonObject,
  jsonSchema,
  ok,
  schema,
} from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import { installTool } from '@slop-lab/part/tools.js';
import { createHash } from 'node:crypto';
import { createToolsetRpc, ToolsetRpcError, type ToolsetRpcOptions } from './toolset-rpc.js';

type Descriptor = {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: Contracts.Json;
};
export type ToolsetToolsOptions = ToolsetRpcOptions & {
  readonly contextId: string;
  readonly allowedTools: readonly string[];
  readonly trustedReadTools?: readonly string[];
  readonly operationControls?: boolean;
  readonly namePrefix?: string;
  readonly invokeTimeoutMs?: number;
};
export type ToolsetToolRegistration = {
  readonly tools: readonly Tools.InstalledTool[];
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>;
  readonly toolIds: Readonly<Record<string, string>>;
  readonly operationToolIds: { readonly get?: string; readonly cancel?: string };
};

export async function createToolsetTools(
  options: ToolsetToolsOptions,
): Promise<ToolsetToolRegistration> {
  if (!options.contextId) throw new TypeError('Toolset contextId is required');
  const allowed = new Set(options.allowedTools);
  if (allowed.size !== options.allowedTools.length)
    throw new TypeError('Toolset allowedTools contains duplicates');
  const trustedReads = new Set(options.trustedReadTools ?? []);
  if ([...trustedReads].some((id) => !allowed.has(id)))
    throw new TypeError('Trusted reads must also be allowed');
  const prefix = options.namePrefix ?? 'toolset_';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(prefix))
    throw new TypeError('Toolset namePrefix must be a short safe identifier');
  const rpc = createToolsetRpc(options);
  const discovered = parseDescriptors(await rpc('schema', {}, AbortSignal.timeout(30_000)));
  const byId = new Map(discovered.map((item) => [item.id, item]));
  for (const id of allowed)
    if (!byId.has(id)) throw new TypeError(`Allowed tool is unavailable: ${id}`);

  const tools: Tools.InstalledTool[] = [];
  const toolSchemas: Record<string, Contracts.Json> = {};
  const toolIds: Record<string, string> = {};
  for (const descriptor of discovered) {
    if (!allowed.has(descriptor.id)) continue;
    const localId = safeName(prefix, descriptor.id);
    toolIds[descriptor.id] = localId;
    toolSchemas[localId] = structuredClone(descriptor.inputSchema);
    tools.push(
      installTool({
        definition: {
          id: localId,
          version: descriptor.version,
          description: descriptor.description,
          input: schema<Contracts.Json>(`part/toolset/${localId}`, isJson),
          output: jsonSchema,
          executor: 'part/function',
          effects: trustedReads.has(descriptor.id) ? 'read' : 'external',
          cancellation: 'cooperative',
          retrySafety: 'never',
          requiredCapabilities: [],
          ...(options.invokeTimeoutMs === undefined ? {} : { timeoutMs: options.invokeTimeoutMs }),
        },
        execute: async (input, context) => {
          const params: Record<string, Contracts.Json> = {
            toolId: descriptor.id,
            contextId: options.contextId,
            arguments: input,
            toolVersion: descriptor.version,
            idempotencyKey: context.operationId,
            async: false,
          };
          if (options.invokeTimeoutMs !== undefined) params.timeoutMs = options.invokeTimeoutMs;
          try {
            const envelope = await rpc('invoke', params, context.signal);
            return nativeResult(envelope, trustedReads.has(descriptor.id));
          } catch (error) {
            return transportFailure(error, trustedReads.has(descriptor.id));
          }
        },
      }),
    );
  }

  const operationToolIds: { get?: string; cancel?: string } = {};
  if (options.operationControls) {
    const get = `${prefix}operation_get`;
    const cancel = `${prefix}operation_cancel`;
    operationToolIds.get = get;
    operationToolIds.cancel = cancel;
    toolSchemas[get] = operationSchema;
    toolSchemas[cancel] = operationSchema;
    tools.push(operationTool(rpc, get, 'operation.get', 'read'));
    tools.push(operationTool(rpc, cancel, 'operation.cancel', 'external'));
  }
  return { tools, toolSchemas, toolIds, operationToolIds };
}

const operationSchema = {
  type: 'object',
  properties: { operationId: { type: 'string' } },
  required: ['operationId'],
  additionalProperties: false,
} as const;

function operationTool(
  rpc: ReturnType<typeof createToolsetRpc>,
  id: string,
  method: 'operation.get' | 'operation.cancel',
  effects: 'read' | 'external',
): Tools.InstalledTool {
  return installTool({
    definition: {
      id,
      version: '1',
      description: `${method} on the configured toolset server`,
      input: schema<{ readonly operationId: string }>(
        `part/toolset/${id}`,
        (value): value is { readonly operationId: string } =>
          isJsonObject(value) &&
          Object.keys(value).length === 1 &&
          typeof value.operationId === 'string',
      ),
      output: jsonSchema,
      executor: 'part/function',
      effects,
      cancellation: 'cooperative',
      retrySafety: effects === 'read' ? 'read-only' : 'never',
      requiredCapabilities: [],
    },
    execute: async (input, context) => {
      try {
        const result = await rpc(method, { operationId: input.operationId }, context.signal);
        return ok({ value: result, content: [], artifacts: [], diagnostics: [] });
      } catch (error) {
        return transportFailure(error, effects === 'read');
      }
    },
  });
}

function parseDescriptors(value: Contracts.Json): readonly Descriptor[] {
  if (!Array.isArray(value)) throw new TypeError('Toolset schema result must be an array');
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !isJsonObject(item) ||
      typeof item.id !== 'string' ||
      typeof item.version !== 'string' ||
      typeof item.description !== 'string' ||
      !isJson(item.inputSchema)
    )
      throw new TypeError('Toolset schema contains an invalid descriptor');
    if (ids.has(item.id))
      throw new TypeError(`Toolset schema contains duplicate descriptor: ${item.id}`);
    ids.add(item.id);
    return {
      id: item.id,
      version: item.version,
      description: item.description,
      inputSchema: structuredClone(item.inputSchema),
    };
  });
}

function nativeResult(
  envelope: Contracts.Json,
  trustedRead: boolean,
): Contracts.Result<Tools.ResultContent> {
  if (!isJsonObject(envelope) || !isJsonObject(envelope.execution))
    return fail('toolset.envelope', 'Toolset returned an invalid operation envelope', 'internal');
  const state = envelope.execution.state;
  if (state === 'completed' && !Object.hasOwn(envelope, 'error'))
    return ok({ value: envelope, content: [], artifacts: [], diagnostics: [] });
  const pending = state === 'queued' || state === 'running' || state === 'input_required';
  return {
    ok: false,
    error: {
      code: pending ? 'part.toolset.pending' : 'part.toolset.native-failure',
      category: pending ? 'unsupported' : state === 'cancelled' ? 'cancelled' : 'internal',
      message: pending
        ? 'Synchronous toolset invocation did not reach a terminal state'
        : 'Toolset operation did not complete successfully',
      retry: 'never',
      effect: nativeEffect(envelope, trustedRead),
      details: envelope,
    },
  };
}

function nativeEffect(envelope: Readonly<Record<string, Contracts.Json>>, trustedRead: boolean) {
  if (trustedRead) return 'not-applied' as const;
  if (!Array.isArray(envelope.effects)) return 'unknown' as const;
  const statuses = envelope.effects.filter(isJsonObject).map((effect) => effect.status);
  if (statuses.includes('unknown')) return 'unknown' as const;
  if (statuses.includes('partial')) return 'partially-applied' as const;
  if (statuses.includes('applied')) return 'applied' as const;
  return statuses.length ? ('not-applied' as const) : ('unknown' as const);
}

function transportFailure(error: unknown, trustedRead: boolean) {
  const rpcError = error instanceof ToolsetRpcError ? error : undefined;
  return fail(
    `toolset.${rpcError?.code.toLowerCase() ?? 'transport'}`,
    rpcError?.message ?? 'Toolset transport failed',
    rpcError?.code === 'CANCELLED' ? 'cancelled' : 'unavailable',
    trustedRead || !rpcError?.sent ? 'not-applied' : 'unknown',
  );
}

function safeName(prefix: string, remoteId: string): string {
  const stem = remoteId.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 31) || 'tool';
  const suffix = createHash('sha256').update(remoteId).digest('hex').slice(0, 8);
  return `${prefix}${stem}_${suffix}`;
}
