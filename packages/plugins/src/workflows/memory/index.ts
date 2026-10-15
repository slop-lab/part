import { canonical, digest, fail, freeze, isJson, ok } from '@part/core/contracts';
import type { Contracts, Runtime, Workflows } from '@part/core/reference';
import { budgetKey, createOperations } from '@part/core/runtime';
import { createChildBudget, numericLimits } from '@part/core/runtime/budgets';
import { costServices } from '@part/core/runtime/costs';
import { executeWorkflow } from './execute.js';
import { memoryGuarantees, workflowSnapshot } from './state.js';
import type { Execution, PreparedRunner, WorkflowServices } from './types.js';
export { callIdentity } from './identity.js';
export { memoryGuarantees } from './state.js';
export type { PreparedRunner, WorkflowServices } from './types.js';
export function createMemoryWorkflowEngine(options: {
  descriptor: Workflows.EngineDescriptor;
  services: WorkflowServices;
  compile(
    request: Workflows.PrepareRequest,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<PreparedRunner>>;
  profileIds?: readonly string[];
}): Workflows.Engine {
  options = {
    ...options,
    descriptor: freeze(structuredClone(options.descriptor)),
    services: { ...options.services },
  };
  const issued = new WeakSet<Workflows.Prepared>();
  const pendingSubmissions = new Map<string, Promise<Workflows.Submission>>();
  const operations = options.services.operations ?? createOperations(),
    preparedTokens = new WeakMap<object, PreparedRunner>();

  const executions = new Map<string, Execution>(),
    submissions = new Map<string, { digest: string; ref: Workflows.ExecutionRef }>();
  const authorized = (execution: Execution, context: Contracts.InvocationContext) =>
    execution.context.principal.subject === context.principal.subject &&
    execution.context.principal.authority === context.principal.authority;
  const getExecution = (
    ref: Workflows.ExecutionRef,
    context: Contracts.InvocationContext,
  ): Contracts.Result<Execution> => {
    const execution = executions.get(ref.id);
    return !execution ||
      ref.engine !== options.descriptor.id ||
      ref.engineVersion !== options.descriptor.version
      ? fail('workflow.execution', 'Workflow execution not found')
      : authorized(execution, context)
        ? ok(execution)
        : fail('workflow.permission', 'Workflow access denied', 'permission');
  };
  const snapshot = (execution: Execution): Workflows.Snapshot =>
    workflowSnapshot(execution, options.descriptor.id);
  return {
    descriptor: options.descriptor,
    async prepare(request, context) {
      if (
        request.engineId !== options.descriptor.id ||
        !options.descriptor.formats.some(
          (f) =>
            f.id === request.definition.format &&
            f.versions.includes(request.definition.formatVersion),
        )
      )
        return fail('workflow.format', 'Unsupported engine or format', 'unsupported');
      if (options.profileIds && !options.profileIds.includes(request.profileId))
        return fail('workflow.profile', 'Workflow profile not installed', 'unsupported');
      for (const required of request.requiredCapabilities)
        if (
          !options.descriptor.capabilities.entries.some(
            (c) => c.id === required && c.status === 'supported',
          )
        )
          return fail('workflow.capability', required, 'unsupported');
      const runner = await options.compile(request, context);
      if (!runner.ok) return runner;
      const localHandle = {};
      preparedTokens.set(localHandle, runner.value);
      const prepared: Workflows.Prepared = freeze({
        definition: structuredClone(request.definition),
        engine: structuredClone(options.descriptor),
        compositionRevision: options.descriptor.capabilities.revision,
        input: runner.value.input.ref,
        output: runner.value.output.ref,
        guarantees: memoryGuarantees,
        compatibility: {
          format: request.definition.format,
          sourceVersion: request.definition.formatVersion,
          adapter: options.descriptor.id,
          adapterVersion: options.descriptor.version,
          status: 'exact-tested-subset',
          ignored: [],
          semantics: memoryGuarantees.nativeSemantics,
        },
        report: [],
        localHandle,
      });
      issued.add(prepared);
      return ok(prepared);
    },
    async start(request, context) {
      if (!isJson(request.input))
        return {
          kind: 'rejected',
          error: fail('workflow.input', 'Input must be lossless JSON').error,
        };
      request = {
        ...request,
        input: structuredClone(request.input),
        ...(request.limits ? { limits: structuredClone(request.limits) } : {}),
      };
      const token = request.prepared.localHandle,
        runner = token && typeof token === 'object' ? preparedTokens.get(token) : undefined;
      if (
        !issued.has(request.prepared) ||
        !runner ||
        request.prepared.engine.id !== options.descriptor.id ||
        request.prepared.compositionRevision !== options.descriptor.capabilities.revision
      )
        return {
          kind: 'rejected',
          error: fail(
            'workflow.prepared',
            'Unknown prepared handle or stale composition',
            'conflict',
          ).error,
        };
      const checked = runner.input.validate(request.input);
      if (!checked.ok)
        return {
          kind: 'rejected',
          error: fail('workflow.input', 'Workflow input validation failed').error,
        };
      const key = canonical({
          principal: context.principal,
          key: request.idempotencyKey ?? request.requestId,
        }),
        submissionDigest = await digest({
          definition: request.prepared.definition.digest,
          input: request.input,
          limits: (request.limits as unknown as Contracts.Json) ?? null,
        });
      const prior = submissions.get(key);
      if (prior) {
        if (prior.digest !== submissionDigest)
          return {
            kind: 'rejected',
            error: fail('workflow.key-conflict', 'Submission key has different content', 'conflict')
              .error,
          };
        return (
          pendingSubmissions.get(key) ?? {
            kind: 'accepted',
            ref: prior.ref,
            snapshot: snapshot(executions.get(prior.ref.id)!),
          }
        );
      }
      const parsedLimits = numericLimits(request.limits);
      if (!parsedLimits.ok) return { kind: 'rejected', error: parsedLimits.error };
      const numeric = parsedLimits.value;
      const budget = createChildBudget(context, numeric);
      const services: Contracts.ServiceAccess = {
        get(key) {
          return key.id === budgetKey.id ? ok(budget as never) : context.services.get(key);
        },
      };
      const deadlines = [context.deadline, request.limits?.deadline]
        .filter((v): v is string => !!v)
        .map(Date.parse);
      if (deadlines.some(Number.isNaN))
        return { kind: 'rejected', error: fail('workflow.deadline', 'Invalid deadline').error };
      const guarded = costServices(context, services, request.limits);
      if (!guarded.ok) return { kind: 'rejected', error: guarded.error };
      const c = {
        ...context,
        services: guarded.value,
        ...(deadlines.length ? { deadline: new Date(Math.min(...deadlines)).toISOString() } : {}),
      };
      const ref: Workflows.ExecutionRef = freeze({
        engine: options.descriptor.id,
        engineVersion: options.descriptor.version,
        id: crypto.randomUUID(),
      });
      const waiting = new Map<
          string,
          {
            ticket: Runtime.WaitTicket;
            schema: Contracts.Schema<Contracts.Json>;
            presentation: Contracts.Json;
          }
        >(),
        active = new Set<Contracts.EntityRef>();
      let execution: Execution | undefined;
      let resolveSubmission!: (result: Workflows.Submission) => void;
      submissions.set(key, { digest: submissionDigest, ref });
      pendingSubmissions.set(
        key,
        new Promise<Workflows.Submission>((resolve) => {
          resolveSubmission = resolve;
        }),
      );
      const started = await operations.begin<Contracts.Json>(
        {
          kind: 'part/workflow',
          childPolicy: 'attached',
          retryOwner: options.descriptor.id,
          ...(request.parent ? { parent: request.parent } : {}),
        },
        (operationContext) =>
          executeWorkflow(operationContext, {
            services: options.services,
            ref,
            request,
            runner,
            input: checked.value,
            active,
            waiting,
            getExecution: () => execution,
          }),
        c,
      );
      if (!started.ok) {
        const result: Workflows.Submission = { kind: 'rejected', error: started.error };
        resolveSubmission(result);
        pendingSubmissions.delete(key);
        submissions.delete(key);
        return result;
      }
      execution = {
        ref,
        prepared: request.prepared,
        context: c,
        handle: started.value,
        native: { definition: request.prepared.definition.id },
        nativeRevision: 0,
        waits: waiting,
        active,
      };
      executions.set(ref.id, execution);
      submissions.set(key, { digest: submissionDigest, ref });
      const accepted: Workflows.Submission = {
        kind: 'accepted',
        ref,
        snapshot: snapshot(execution),
      };
      resolveSubmission(accepted);
      pendingSubmissions.delete(key);
      return accepted;
    },
    async get(ref, context) {
      const result = getExecution(ref, context);
      return result.ok ? ok(snapshot(result.value)) : result;
    },
    async requestCancel(ref, reason, context) {
      const result = getExecution(ref, context);
      return result.ok ? result.value.handle.requestCancel(reason) : result;
    },
    observe(ref, context) {
      const result = getExecution(ref, context);
      return result.ok
        ? result.value.handle.observe({ signal: context.signal })
        : { async *[Symbol.asyncIterator]() {} };
    },
    async action(ref, command, context) {
      const result = getExecution(ref, context),
        rejected = (error: Contracts.Failure): Contracts.CommandReceipt => ({
          kind: 'rejected',
          commandId: command.commandId,
          error,
        });
      if (!result.ok) return rejected(result.error);
      if (
        command.actionId !== 'part.workflow/respond' ||
        command.actionVersion !== 1 ||
        !options.services.waits
      )
        return rejected(fail('workflow.action', 'Action not installed', 'unsupported').error);
      const input = command.input as unknown as {
        ticketId: string;
        revision: string;
        response: Contracts.Json;
      };
      const entry = input && result.value.waits.get(input.ticketId);
      if (!entry || entry.ticket.revision !== input.revision)
        return rejected(fail('workflow.ticket', 'Ticket is absent or stale', 'conflict').error);
      const responded = await options.services.waits.respond(
        entry.ticket,
        input.response,
        command.commandId,
        context,
      );
      if (!responded.ok) return rejected(responded.error);
      return {
        kind: 'completed',
        commandId: command.commandId,
        result: responded.value as unknown as Contracts.Json,
        effect: 'not-applicable',
        commit: [],
      };
    },
    async inspect(ref, view, context) {
      const result = getExecution(ref, context);
      if (!result.ok) return result;
      if (view !== 'waits')
        return fail('workflow.view', 'Inspect view not installed', 'unsupported');
      const open = snapshot(result.value).waitingOn.map((ref) => result.value.waits.get(ref.id)!);
      return ok({
        kind: 'waits',
        schema: { id: 'part/workflow-waits', version: 1 },
        data: open.map((entry) => ({
          ticket: { ...entry.ticket },
          responseSchema: { ...entry.schema.ref },
          presentation: structuredClone(entry.presentation),
        })),
      });
    },
    async reconcileSubmission(key, context) {
      const found = submissions.get(canonical({ principal: context.principal, key }));
      return ok(found?.ref ?? null);
    },
  };
}
