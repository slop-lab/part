import { messageItem } from '@slop-lab/part/context';
import { isJsonObject } from '@slop-lab/part/contracts';
import type { Context, Contracts, Convenience, Model, Runtime } from '@slop-lab/part/reference';
import { createAgent } from '../agent/index.js';
import { promptContent } from './content.js';
import { createAcpToolBridge } from './permissions.js';
import { AcpError } from './types.js';
import type { AcpAgentOptions, AcpSessionSetup } from './types.js';

interface Turn {
  abort: AbortController;
  handle?: Runtime.ExecutionHandle<Model.Response>;
  done?: Promise<Contracts.Json>;
}
export async function createAcpSession(
  setup: AcpSessionSetup,
  options: AcpAgentOptions & {
    maxHistoryTurns: number;
    maxPromptBytes: number;
    turnTimeoutMs: number;
  },
) {
  let turn: Turn | undefined,
    closed = false;
  const history: Context.SemanticItem[] = [];
  const update = (value: Contracts.Json) =>
    options.connection.notify('session/update', { sessionId: setup.sessionId, update: value });
  const tools = createAcpToolBridge({
    ...options,
    sessionId: setup.sessionId,
    permissions: options.permissions ?? 'writes',
    signal: () => turn?.abort.signal ?? AbortSignal.abort(),
    update,
  });
  const mcp = setup.mcpServers.length ? await options.connectMcp!(setup) : undefined;
  let created: Contracts.Result<
    Convenience.Agent<string | readonly Context.SemanticItem[], Model.Response>
  >;
  try {
    const configured = await options.configureSession(setup);
    created = createAgent({
      ...configured,
      tools: [...(configured.tools ?? []), ...(mcp?.tools ?? [])],
      toolSchemas: { ...(configured.toolSchemas ?? {}), ...(mcp?.toolSchemas ?? {}) },
      executors: [...(configured.executors ?? []), ...(mcp?.executors ?? [])],
      principal: configured.principal ?? { subject: setup.sessionId, authority: 'part/acp' },
      limits: { maxModelInvocations: 8, maxToolDispatches: 16, ...configured.limits },
      middleware: [...(configured.middleware ?? []), tools.middleware],
    });
  } catch (error) {
    const cleanup = await mcp?.close();
    if (cleanup && (cleanup.errors.length || cleanup.unresolved.length))
      throw new AcpError(-32603, 'Session setup cleanup incomplete', undefined, cleanup);
    throw error;
  }
  if (!created.ok) {
    const cleanup = await mcp?.close();
    throw new AcpError(-32603, 'Agent configuration failed', { code: created.error.code }, cleanup);
  }
  const agent: Convenience.Agent<string | readonly Context.SemanticItem[], Model.Response> =
    created.value;
  async function execute(current: Turn, content: Model.ContentPart[]): Promise<Contracts.Json> {
    let failure: unknown,
      streamed = '';
    const timer = setTimeout(() => current.abort.abort('turn-timeout'), options.turnTimeoutMs);
    const cancel = () => {
      void current.handle?.requestCancel('acp-cancel');
    };
    current.abort.signal.addEventListener('abort', cancel);
    try {
      const user = await messageItem('user', content);
      if (current.abort.signal.aborted) return { stopReason: 'cancelled' };
      const started = await agent.start([...history, user]);
      if (!started.ok)
        throw new AcpError(-32603, 'Run admission failed', { code: started.error.code });
      current.handle = started.value;
      if (current.abort.signal.aborted) await current.handle.requestCancel('acp-cancel');
      const progress = (async () => {
        for await (const event of current.handle!.observe({ bufferSize: 4096 })) {
          if (event.kind === 'gap')
            throw new AcpError(-32603, 'ACP progress observation overflowed');
          if (
            event.type === 'part.model/text' &&
            isJsonObject(event.payload) &&
            typeof event.payload.text === 'string'
          ) {
            streamed += event.payload.text;
            await update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: event.payload.text },
            });
          } else if (event.type === 'part.tool/result') await tools.result(event.payload);
        }
      })().catch((error) => {
        failure = error;
        current.abort.abort('observation-failed');
      });
      const outcome = await current.handle.done;
      await progress;
      if (failure) throw failure;
      await tools.finish();
      if (outcome.phase === 'cancelled' || current.abort.signal.aborted)
        return { stopReason: 'cancelled' };
      if (outcome.phase === 'failed' && outcome.error.code === 'part.driver.turn-limit')
        return { stopReason: 'max_turn_requests' };
      if (outcome.phase !== 'completed')
        throw new AcpError(-32603, 'Managed run failed', {
          code: outcome.error.code,
          category: outcome.error.category,
          effect: outcome.effect,
        });
      const text = outcome.result.content
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join('');
      // Drivers may return a final response without text deltas. Do not duplicate streamed output.
      if (!streamed && text)
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      history.push(user, await messageItem('assistant', [{ kind: 'text', text }]));
      return {
        stopReason:
          outcome.result.finish.normalized === 'length'
            ? 'max_tokens'
            : outcome.result.finish.normalized === 'content_filter'
              ? 'refusal'
              : 'end_turn',
      };
    } finally {
      clearTimeout(timer);
      current.abort.signal.removeEventListener('abort', cancel);
      try {
        await tools.finish();
      } finally {
        if (turn === current) turn = undefined;
      }
    }
  }
  return {
    prompt(value: Contracts.Json, signal?: AbortSignal): Promise<Contracts.Json> {
      if (closed) throw new AcpError(-32600, 'Session is closed');
      if (turn) throw new AcpError(-32000, 'A prompt is already active in this session');
      if (history.length >= options.maxHistoryTurns * 2)
        throw new AcpError(-32000, 'Session history capacity reached; create a new session');
      const content = promptContent(value, options.maxPromptBytes),
        current: Turn = { abort: new AbortController() };
      turn = current;
      const cancel = () => current.abort.abort('request-cancelled');
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      return (current.done = execute(current, content).finally(() =>
        signal?.removeEventListener('abort', cancel),
      ));
    },
    cancel() {
      turn?.abort.abort('client-cancel');
    },
    async close(): Promise<Contracts.CleanupReport> {
      closed = true;
      const current = turn;
      current?.abort.abort('connection-closed');
      await current?.done?.catch(() => {});
      const report = await agent.dispose();
      const remote = await mcp?.close();
      return remote
        ? {
            released: [...report.released, ...remote.released],
            unresolved: [...report.unresolved, ...remote.unresolved],
            errors: [...report.errors, ...remote.errors],
          }
        : report;
    },
  };
}
