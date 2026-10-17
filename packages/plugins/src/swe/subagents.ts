import { fail, isJson, isJsonObject, ok, schema } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Runtime, Tools } from '@slop-lab/part/reference/index.js';
import { operationOwnerKey } from '@slop-lab/part/runtime/operations.js';
import { installTool } from '@slop-lab/part/tools.js';

export const subagentToolId = 'swe_subagent';
export const subagentToolSchemas = {
  [subagentToolId]: {
    type: 'object',
    properties: {
      task: { type: 'string', minLength: 1 },
      context: { type: 'string', minLength: 1 },
    },
    required: ['task', 'context'],
    additionalProperties: false,
  },
} as const satisfies Readonly<Record<string, Contracts.Json>>;

export interface SubagentInput {
  readonly task: string;
  readonly context: string;
}

export interface SubagentAuthority {
  readonly purpose: string;
  readonly allowedActions: readonly string[];
}

export interface ManagedChildRequest {
  readonly driverId: string;
  readonly input: SubagentInput;
  readonly authority: SubagentAuthority & {
    readonly principal: Contracts.InvocationContext['principal'];
  };
  readonly parent: Contracts.EntityRef;
}

export interface ChildRunPort<T> {
  start(
    request: ManagedChildRequest,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Runtime.ExecutionHandle<T>>>;
}

export type SubagentToolResult = {
  readonly status: 'completed';
  readonly result: Contracts.Json;
};

export interface SubagentToolOptions<T> {
  readonly childRuns: ChildRunPort<T>;
  readonly driverId: string;
  readonly authority: SubagentAuthority;
  readonly maxChildren?: number;
}

export const subagentInputSchema = schema<SubagentInput>(
  'part/swe-subagent-input',
  (value): value is SubagentInput =>
    isJsonObject(value) &&
    typeof value.task === 'string' &&
    value.task.length > 0 &&
    typeof value.context === 'string' &&
    value.context.length > 0,
);

export function createSubagentTools<T>(
  options: SubagentToolOptions<T>,
): readonly Tools.InstalledTool[] {
  const maximum = options.maxChildren ?? 4;
  const startedByRoot = new Map<string, number>();
  return [
    installTool<SubagentInput, SubagentToolResult>({
      definition: {
        id: subagentToolId,
        version: '1',
        description: 'Run one bounded managed coding subagent with explicit task context',
        input: subagentInputSchema,
        executor: 'part/function',
        effects: 'write',
        cancellation: 'cooperative',
        retrySafety: 'never',
        requiredCapabilities: [],
      },
      async execute(input, context) {
        const toolRef = {
          owner: 'part/operations',
          kind: 'part/tool',
          id: context.operationId,
        };
        const owner = context.services.get(operationOwnerKey);
        const snapshot = owner.ok ? owner.value.get(toolRef) : undefined;
        const rootId = snapshot?.ok
          ? (snapshot.value.parent?.id ?? context.correlationId)
          : context.correlationId;
        const startedChildren = startedByRoot.get(rootId) ?? 0;
        if (!Number.isSafeInteger(maximum) || maximum < 1 || startedChildren >= maximum)
          return fail('swe.child-limit', 'Managed subagent child limit reached', 'conflict');
        startedByRoot.set(rootId, startedChildren + 1);
        const started = await options.childRuns.start(
          {
            driverId: options.driverId,
            input: structuredClone(input),
            authority: {
              purpose: options.authority.purpose,
              allowedActions: [...options.authority.allowedActions],
              principal: { ...context.principal },
            },
            parent: toolRef,
          },
          context,
        );
        if (!started.ok) {
          startedByRoot.set(rootId, startedChildren);
          return started;
        }
        const cancel = () => {
          void started.value.requestCancel('parent-cancelled');
        };
        context.signal.addEventListener('abort', cancel, { once: true });
        if (context.signal.aborted) cancel();
        try {
          const outcome = await started.value.done;
          switch (outcome.phase) {
            case 'completed':
              if (!isJson(outcome.result))
                return fail(
                  'swe.child-result',
                  'Managed subagent returned a non-JSON result',
                  'validation',
                  outcome.effect,
                );
              return ok({
                value: { status: 'completed', result: outcome.result },
                content: [],
                artifacts: [],
                diagnostics: [],
              });
            case 'failed':
              return {
                ok: false,
                error: { ...outcome.error, effect: outcome.effect },
              };
            case 'cancelled':
              return {
                ok: false,
                error: outcome.error
                  ? { ...outcome.error, effect: outcome.effect }
                  : fail(
                      'swe.child-cancelled',
                      'Managed subagent was cancelled',
                      'cancelled',
                      outcome.effect,
                    ).error,
              };
            case 'abandoned':
              return {
                ok: false,
                error: { ...outcome.error, effect: outcome.effect },
              };
          }
        } finally {
          context.signal.removeEventListener('abort', cancel);
        }
      },
    }),
  ];
}
