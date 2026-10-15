import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import type { AcpConnection } from './types.js';

export interface AcpToolState {
  id: string;
  toolId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}
export function createAcpToolBridge(options: {
  connection: AcpConnection;
  sessionId: string;
  permissions: 'writes' | 'all';
  signal(): AbortSignal;
  update(value: Contracts.Json): Promise<void>;
}) {
  const calls = new Map<string, AcpToolState>();
  const middleware: Tools.Middleware = {
    id: 'part/acp-permission',
    version: '1',
    async decide(plan, context) {
      const signal = AbortSignal.any([context.signal, options.signal()]);
      if (signal.aborted) return fail('acp.cancelled', 'Turn was cancelled', 'cancelled');
      const key = `${plan.call.modelCallId ?? ''}/${plan.call.logicalCallId}`,
        previous = calls.get(key),
        id = previous?.id ?? crypto.randomUUID();
      const toolCall = {
        toolCallId: id,
        title: plan.definition.description || plan.definition.id,
        kind:
          plan.definition.effects === 'read'
            ? 'read'
            : plan.definition.effects === 'write'
              ? 'edit'
              : 'other',
        status: 'pending',
        rawInput: plan.validatedArguments as Contracts.Json,
      };
      calls.set(key, { id, toolId: plan.definition.id, status: 'pending' });
      await options.update({
        sessionUpdate: previous ? 'tool_call_update' : 'tool_call',
        ...toolCall,
      });
      if (options.permissions === 'all' || plan.definition.effects !== 'read') {
        let response: Contracts.Json;
        try {
          response = await options.connection.request(
            'session/request_permission',
            {
              sessionId: options.sessionId,
              toolCall,
              options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              ],
            },
            { signal },
          );
        } catch {
          return fail(
            'acp.permission',
            'Permission request failed or was cancelled',
            signal.aborted ? 'cancelled' : 'permission',
          );
        }
        if (signal.aborted) return fail('acp.cancelled', 'Turn was cancelled', 'cancelled');
        if (
          !isJsonObject(response) ||
          !isJsonObject(response.outcome) ||
          response.outcome.outcome !== 'selected' ||
          response.outcome.optionId !== 'allow-once'
        )
          return ok({
            kind: 'deny',
            error: fail('acp.denied', 'Client did not grant this tool attempt', 'permission').error,
          });
      }
      calls.get(key)!.status = 'in_progress';
      await options.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'in_progress',
      });
      return ok({ kind: 'allow' });
    },
  };
  return {
    middleware,
    async result(payload: Contracts.Json) {
      if (!isJsonObject(payload) || typeof payload.toolId !== 'string') return;
      // The basic driver dispatches calls sequentially. Core progress deliberately
      // exposes effect evidence rather than unrestricted tool result content.
      const call = [...calls.values()].find(
        (item) => item.toolId === payload.toolId && item.status === 'in_progress',
      );
      if (!call) return;
      call.status = payload.outcome === 'returned' ? 'completed' : 'failed';
      await options.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: call.id,
        status: call.status,
        rawOutput: payload,
      });
    },
    async finish() {
      for (const call of calls.values())
        if (call.status === 'pending' || call.status === 'in_progress') {
          call.status = 'failed';
          await options.update({
            sessionUpdate: 'tool_call_update',
            toolCallId: call.id,
            status: 'failed',
          });
        }
      calls.clear();
    },
  };
}
