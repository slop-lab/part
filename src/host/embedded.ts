import { createControl, installAction, installQuery } from '../client/control.js';
import { createWatchHub } from '../client/index.js';
import {
  fail,
  jsonSchema,
  localContext,
  ok,
  schema,
  stringSchema,
} from '../foundation/contracts.js';
import type {
  Client,
  Context,
  Contracts,
  Convenience,
  Model,
  Projection,
  Runtime,
} from '../reference/index.js';
export const nullSchema = schema<null>('part/null', (value): value is null => value === null);
export function createEmbeddedEndpoint(
  agent: Convenience.Agent<string | readonly Context.SemanticItem[], Model.Response>,
  options: { context?: Contracts.InvocationContext; capabilities?: Contracts.CapabilitySet } = {},
): Contracts.Result<
  Client.Endpoint & {
    hub: ReturnType<typeof createWatchHub>;
    close(): Promise<Contracts.CleanupReport>;
  }
> {
  const context = options.context ?? localContext(),
    composition = agent.inspectComposition();
  const capabilities = options.capabilities ?? {
    revision: composition.revision,
    entries: [
      ...composition.capabilities.entries,
      {
        id: 'part/commands',
        contractVersion: 1,
        status: 'supported' as const,
        implementedBy: 'part/embedded',
        constraints: { dedupe: 'memory', scope: 'endpoint-lifetime', capacity: 1000 },
      },
    ],
  };
  const hub = createWatchHub(capabilities),
    runs = new Map<string, Runtime.ExecutionHandle<Model.Response>>();
  let closed = false;
  const allowed = (caller: Contracts.InvocationContext) =>
    !closed &&
    caller.principal.subject === context.principal.subject &&
    caller.principal.authority === context.principal.authority;
  const descriptor = (
    id: string,
    input: Contracts.SchemaRef,
    output: Contracts.SchemaRef,
    execution: Contracts.ActionDescriptor['execution'],
    enabled = true,
  ): Contracts.ActionDescriptor => ({
    id,
    version: 1,
    input,
    output,
    execution,
    availability: { state: enabled ? 'available' : 'disabled', checkedAt: composition.revision },
  });
  const start = installAction({
    id: 'part.run/start',
    version: 1,
    input: stringSchema,
    output: jsonSchema,
    async describe(_target, caller) {
      return ok(
        descriptor(
          'part.run/start',
          stringSchema.ref,
          jsonSchema.ref,
          'operation',
          allowed(caller),
        ),
      );
    },
    async execute(request) {
      const created = await agent.start(request.input);
      if (!created.ok)
        return { kind: 'rejected' as const, commandId: request.commandId, error: created.error };
      const handle = created.value;
      runs.set(handle.ref.id, handle);
      const userId = `${handle.ref.id}/user`,
        assistantId = `${handle.ref.id}/assistant`;
      const item = (
        id: string,
        label: string,
        text: string,
        actions: readonly Contracts.ActionDescriptor[] = [],
      ): Projection.Item => ({
        id,
        type: 'part/message',
        schemaVersion: 1,
        revision: '0',
        payload: { text },
        fallback: { label, text },
        source: handle.ref,
        actions,
        artifacts: [],
      });
      hub.upsert(item(userId, 'You', request.input));
      hub.upsert(
        item(assistantId, 'Assistant', '', [
          descriptor('part.run/cancel', nullSchema.ref, jsonSchema.ref, 'immediate'),
        ]),
      );
      void (async () => {
        const progress = (async () => {
          let offset = 0;
          for await (const update of handle.observe())
            if (update.kind === 'data') {
              if (update.type === 'part.model/text') {
                const payload = update.payload as { text: string };
                hub.delta({
                  itemId: assistantId,
                  partId: 'text',
                  generation: handle.ref.id,
                  offset,
                  text: payload.text,
                });
                offset += payload.text.length;
              }
              if (update.type === 'part.tool/result') {
                const value = update.payload as { toolId: string; outcome: string; effect: string };
                hub.upsert({
                  id: `${handle.ref.id}/tool/${crypto.randomUUID()}`,
                  type: 'part/tool',
                  schemaVersion: 1,
                  revision: '0',
                  payload: update.payload,
                  fallback: {
                    label: value.toolId,
                    text: `${value.outcome} · effect ${value.effect}`,
                  },
                  actions: [],
                  artifacts: [],
                });
              }
            }
        })();
        const outcome = await handle.done;
        await progress;
        const text =
          outcome.phase === 'completed'
            ? outcome.result.content
                .filter((p) => p.kind === 'text')
                .map((p) => p.text)
                .join('')
            : outcome.phase === 'failed' || outcome.phase === 'abandoned'
              ? outcome.error.message
              : 'Cancelled';
        hub.upsert({
          ...item(assistantId, 'Assistant', text),
          revision: handle.snapshot().revision,
          payload: { phase: outcome.phase, text, effect: outcome.effect },
        });
      })();
      return {
        kind: 'accepted' as const,
        commandId: request.commandId,
        operation: handle.ref,
        commit: [],
      };
    },
  });
  const cancel = installAction({
    id: 'part.run/cancel',
    version: 1,
    input: nullSchema,
    output: jsonSchema,
    async describe(target, caller) {
      return ok(
        descriptor(
          'part.run/cancel',
          nullSchema.ref,
          jsonSchema.ref,
          'immediate',
          allowed(caller) && !!target && runs.has(target.id),
        ),
      );
    },
    async execute(request) {
      const run = request.target && runs.get(request.target.id);
      if (!run || request.target?.owner !== run.ref.owner)
        return {
          kind: 'rejected' as const,
          commandId: request.commandId,
          error: fail('run.missing', 'Run not found').error,
        };
      const cancellation = await run.requestCancel('client-request');
      return cancellation.ok
        ? {
            kind: 'completed' as const,
            commandId: request.commandId,
            result: cancellation.value as unknown as Contracts.Json,
            effect: 'not-applicable' as const,
            commit: [],
          }
        : { kind: 'rejected' as const, commandId: request.commandId, error: cancellation.error };
    },
  });
  const control = createControl({
    actions: [start, cancel],
    queries: [
      installQuery({
        id: 'part/capabilities',
        version: 1,
        input: nullSchema,
        output: jsonSchema,
        read: async () => ok(capabilities as unknown as Contracts.Json),
      }),
      installQuery({
        id: 'part/composition',
        version: 1,
        input: nullSchema,
        output: jsonSchema,
        read: async () => ok(composition as unknown as Contracts.Json),
      }),
      installQuery({
        id: 'part.run/get',
        version: 1,
        input: stringSchema,
        output: jsonSchema,
        read: async (id) => {
          const run = runs.get(id);
          return run
            ? ok(run.snapshot() as unknown as Contracts.Json)
            : fail('run.missing', 'Run not found');
        },
      }),
    ],
  });
  if (!control.ok) return control;
  return ok({
    hub,
    async command(request, caller) {
      return allowed(caller)
        ? control.value.invoke(request, caller)
        : {
            kind: 'rejected',
            commandId: request.commandId,
            error: fail('endpoint.permission', 'Endpoint access denied', 'permission').error,
          };
    },
    async query(request, caller) {
      if (!allowed(caller))
        return fail('endpoint.permission', 'Endpoint access denied', 'permission');
      if (request.queryId === 'part/actions' && request.version === 1) {
        const result = await control.value.describe(request.target, caller);
        return result.ok ? ok(result.value as unknown as Contracts.Json) : result;
      }
      return control.value.query(request, caller);
    },
    async watch(_request, caller) {
      return allowed(caller)
        ? hub.watch(caller)
        : fail('endpoint.permission', 'Endpoint access denied', 'permission');
    },
    async close() {
      closed = true;
      hub.close();
      return agent.dispose();
    },
  });
}
