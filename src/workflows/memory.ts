import { combineEffects } from '../agent/basic-driver.js';
import { provenance } from '../context/index.js';
import {
  canonical,
  digest,
  fail,
  freeze,
  isJson,
  jsonSchema,
  ok,
} from '../foundation/contracts.js';
import type { Contracts, Model, Results, Runtime, Scripts, Workflows } from '../reference/index.js';
import { createChildBudget, numericLimits } from '../runtime/budgets.js';
import { costServices } from '../runtime/costs.js';
import type { OperationContext, Operations } from '../runtime/index.js';
import { budgetKey, createOperations } from '../runtime/index.js';
export interface WorkflowServices {
  readonly operations?: Operations;
  readonly model?: Model.Gateway;
  readonly scripts?: Scripts.Service;
  readonly runs?: Runtime.RunService;
  readonly results?: Results.Service;
  readonly waits?: Runtime.SuspensionPort;
}
export interface PreparedRunner {
  readonly input: Contracts.Schema<Contracts.Json>;
  readonly output: Contracts.Schema<Contracts.Json>;
  execute(
    input: Contracts.Json,
    steps: Workflows.StepContext,
    context: OperationContext,
    record: (outcome: Runtime.ManagedOutcome<unknown>) => void,
  ): Promise<Contracts.Result<Contracts.Json>>;
}
const stepScopes = new WeakMap<
  Workflows.StepContext,
  (context: OperationContext) => Workflows.StepContext
>();
export function scopeStepContext(
  steps: Workflows.StepContext,
  context: OperationContext,
): Workflows.StepContext {
  const bind = stepScopes.get(steps);
  if (!bind) throw new Error('Step context cannot be rebound by this engine');
  return bind(context);
}
export const memoryGuarantees: Workflows.Guarantees = freeze({
  control: 'runner-enforced',
  effects: 'runner-path-only',
  checkpoint: 'none',
  submissionDedupe: 'memory',
  scriptCancellation: 'cooperative',
  nativeSemantics: [
    'Trusted in-process definitions',
    'No stack recovery or automatic effect retry',
  ],
});
export async function callIdentity(
  execution: Workflows.ExecutionRef,
  stepKey: string,
  input: Contracts.Json,
  iterationPath: readonly (string | number)[] = [],
  attempt = 1,
): Promise<Workflows.CallIdentity> {
  return { workflow: execution, stepKey, iterationPath, attempt, inputDigest: await digest(input) };
}
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
  interface Execution {
    ref: Workflows.ExecutionRef;
    prepared: Workflows.Prepared;
    context: Contracts.InvocationContext;
    handle: Runtime.ExecutionHandle<Contracts.Json>;
    native: Contracts.Json;
    nativeRevision: number;
    waits: Map<
      string,
      {
        ticket: Runtime.WaitTicket;
        schema: Contracts.Schema<Contracts.Json>;
        presentation: Contracts.Json;
      }
    >;
    active: Set<Contracts.EntityRef>;
    output?: Workflows.Output;
  }
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
  const snapshot = (execution: Execution): Workflows.Snapshot => {
    const state = execution.handle.snapshot(),
      phase = (
        {
          pending: 'queued',
          running: 'running',
          waiting: 'waiting',
          completed: 'succeeded',
          failed: 'failed',
          cancelled: 'cancelled',
          abandoned: 'unknown',
        } as const
      )[state.phase];
    const waiting = ['pending', 'running', 'waiting'].includes(state.phase)
      ? [...execution.waits.values()].filter((v) => v.ticket.state === 'open')
      : [];
    return {
      ref: execution.ref,
      revision: `${state.revision}/${execution.nativeRevision}`,
      definitionDigest: execution.prepared.definition.digest,
      owner: options.descriptor.id,
      phase: phase === 'running' && waiting.length ? 'waiting' : phase,
      nativeState: {
        schema: { id: `${options.descriptor.id}/state`, version: 1 },
        data: structuredClone(execution.native),
      },
      guarantees: memoryGuarantees,
      activeOperations: [...execution.active],
      waitingOn: waiting.map((w) => ({
        owner: 'part/waits',
        kind: w.ticket.type,
        id: w.ticket.id,
      })),
      ...(state.phase === 'completed' && execution.output ? { output: execution.output } : {}),
      diagnostics: state.error ? [state.error] : [],
      actions: waiting.length
        ? [
            {
              id: 'part.workflow/respond',
              version: 1,
              input: { id: 'part/workflow-response', version: 1 },
              output: jsonSchema.ref,
              execution: 'immediate',
              availability: { state: 'available', checkedAt: state.revision },
            },
          ]
        : [],
      effect: state.effect,
    };
  };
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
        async (operationContext) => {
          let effect: Contracts.EffectState = 'not-attempted';
          const commit: Contracts.CommitEvidence[] = [];
          const memo = new Map<string, { digest: string; pending: Promise<unknown> }>();
          const memoize = async <T>(
            identity: Workflows.CallIdentity,
            input: Contracts.Json,
            body: () => Promise<T>,
          ): Promise<T> => {
            if (
              identity.workflow.id !== ref.id ||
              identity.workflow.engine !== ref.engine ||
              identity.workflow.engineVersion !== ref.engineVersion ||
              !identity.stepKey ||
              !Number.isSafeInteger(identity.attempt) ||
              identity.attempt < 1 ||
              identity.inputDigest !== (await digest(input))
            )
              throw Error('Invalid workflow call identity');
            const key = canonical({
                step: identity.stepKey,
                path: identity.iterationPath,
                attempt: identity.attempt,
              }),
              fingerprint = await digest(input);
            const old = memo.get(key);
            if (old) {
              if (old.digest !== fingerprint) throw Error('Workflow call identity conflict');
              return old.pending as Promise<T>;
            }
            if (operationContext.signal.aborted) throw Error('Workflow cancelled');
            operationContext.progress.publish('part.workflow/step', {
              stepKey: identity.stepKey,
              iterationPath: identity.iterationPath,
              attempt: identity.attempt,
            });
            if (execution) {
              execution.native = {
                stepKey: identity.stepKey,
                iterationPath: identity.iterationPath,
                attempt: identity.attempt,
              };
              execution.nativeRevision++;
            }
            const pending = Promise.resolve().then(body);
            memo.set(key, { digest: fingerprint, pending });
            return pending;
          };
          const missing = (name: string): Runtime.ManagedOutcome<never> => ({
            phase: 'failed',
            error: fail('workflow.service', `${name} is not installed`, 'unsupported').error,
            effect: 'not-attempted',
            commit: [],
            unsettledChildren: [],
          });
          const runHandle = async <T>(
            result: Contracts.Result<Runtime.ExecutionHandle<T>>,
          ): Promise<Runtime.ManagedOutcome<T>> => {
            if (!result.ok)
              return {
                phase: 'failed',
                error: result.error,
                effect: 'not-attempted',
                commit: [],
                unsettledChildren: [],
              };
            active.add(result.value.ref);
            const outcome = await result.value.done;
            active.delete(result.value.ref);
            effect = combineEffects(effect, outcome.effect);
            commit.push(...outcome.commit);
            return outcome;
          };
          const makeStepContext = (invocation: OperationContext): Workflows.StepContext => {
            const scoped: Workflows.StepContext = {
              execution: ref,
              signal: invocation.signal,
              limits: request.limits ?? {},
              script: (identity, input) =>
                memoize(identity, input as unknown as Contracts.Json, async () => {
                  const outcome = options.services.scripts
                    ? await runHandle(await options.services.scripts.execute(input, invocation))
                    : missing('scripts');
                  if (
                    outcome.phase === 'completed' &&
                    (outcome.result.exitCode !== 0 || outcome.result.completeness !== 'complete')
                  )
                    return {
                      phase: 'failed',
                      effect: outcome.effect,
                      commit: outcome.commit,
                      unsettledChildren: outcome.unsettledChildren,
                      error: fail(
                        'workflow.script-exit',
                        'Script exited unsuccessfully or capture is incomplete',
                      ).error,
                    };
                  return outcome;
                }),
              model: (identity, input) =>
                memoize(identity, input as unknown as Contracts.Json, async () =>
                  options.services.model
                    ? runHandle(await options.services.model.invoke(input, invocation))
                    : missing('model'),
                ),
              agent: (identity, input) =>
                memoize(
                  identity,
                  {
                    driver: input.driver,
                    input: input.input,
                    compositionRevision: input.composition.inspection.revision,
                  },
                  async () =>
                    options.services.runs
                      ? runHandle(await options.services.runs.start(input, invocation))
                      : missing('runs'),
                ),
              submit: (identity, input) =>
                memoize(identity, input as unknown as Contracts.Json, async () =>
                  input.producedBy.id !== ref.id || input.producedBy.owner !== ref.engine
                    ? Promise.resolve(
                        fail(
                          'workflow.result-owner',
                          'Result producer is not this execution',
                          'permission',
                        ),
                      )
                    : options.services.results
                      ? options.services.results.submit(input, invocation)
                      : fail('workflow.results', 'Results service not installed', 'unsupported'),
                ),
              wait: (identity, input) =>
                memoize(
                  identity,
                  {
                    type: input.type,
                    responseSchema: { ...input.responseSchema.ref },
                    presentation: input.presentation,
                    bindingDigest: input.bindingDigest,
                  },
                  async () => {
                    if (!options.services.waits)
                      return fail('workflow.waits', 'Wait service not installed', 'unsupported');
                    const opened = await options.services.waits.open(
                      {
                        ...input,
                        bindingDigest: await digest({
                          definition: request.prepared.definition.digest,
                          execution: ref.id,
                          binding: input.bindingDigest,
                        }),
                      },
                      invocation,
                    );
                    if (opened.ok)
                      waiting.set(opened.value.id, {
                        ticket: opened.value,
                        schema: input.responseSchema,
                        presentation: structuredClone(input.presentation),
                      });
                    if (opened.ok) {
                      if (execution) execution.nativeRevision++;
                      operationContext.progress.publish('part.workflow/wait', {
                        ticketId: opened.value.id,
                      });
                    }
                    return opened;
                  },
                ),
              async response(ticket) {
                const entry = waiting.get(ticket.id);
                if (!entry || !options.services.waits)
                  return fail('workflow.ticket', 'Ticket not owned by this execution');
                const response = await invocation.wait(
                  options.services.waits.wait(entry.ticket, entry.schema, invocation),
                );
                entry.ticket = {
                  ...entry.ticket,
                  state: response.ok
                    ? 'resolved'
                    : invocation.signal.aborted
                      ? 'cancelled'
                      : 'expired',
                };
                return response;
              },
            };
            stepScopes.set(scoped, makeStepContext);
            return scoped;
          };
          const stepContext = makeStepContext(operationContext);
          let result: Contracts.Result<Contracts.Json>;
          try {
            result = await runner.execute(
              structuredClone(checked.value),
              stepContext,
              operationContext,
              (outcome) => {
                effect = combineEffects(effect, outcome.effect);
                commit.push(...outcome.commit);
              },
            );
          } catch {
            return {
              phase: 'failed',
              error: fail('workflow.exception', 'Workflow definition failed', 'internal', 'unknown')
                .error,
              effect: 'unknown',
              commit,
              unsettledChildren: [],
            };
          }
          if (!result.ok)
            return {
              phase: 'failed',
              error: result.error,
              effect: combineEffects(effect, result.error.effect ?? 'not-attempted'),
              commit,
              unsettledChildren: [],
            };
          const validated = runner.output.validate(result.value);
          if (!validated.ok)
            return {
              phase: 'failed',
              error: fail('workflow.output', 'Workflow output validation failed').error,
              effect,
              commit,
              unsettledChildren: [],
            };
          const encoded = runner.output.codec?.encode(validated.value);
          if (!encoded?.ok)
            return {
              phase: 'failed',
              error: fail('workflow.codec', 'Workflow output codec failed').error,
              effect,
              commit,
              unsettledChildren: [],
            };
          if (execution) {
            execution.output = freeze({
              kind: 'native',
              data: structuredClone(encoded.value),
              validation: 'engine-reported',
              provenance,
            });
            execution.nativeRevision++;
          }
          return {
            phase: 'completed',
            result: encoded.value,
            effect,
            commit,
            unsettledChildren: [],
          };
        },
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
