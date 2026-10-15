import { canonical, digest, fail } from '../../contracts/index.js';
import type { Contracts } from '../../reference/contracts.js';
import type { Runtime } from '../../reference/runtime.js';
import type { Workflows } from '../../reference/workflows.js';
import type { OperationContext } from '../../runtime/operations.js';
import type { Execution, WorkflowServices } from './types.js';
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

export function createStepContext(
  operationContext: OperationContext,
  options: {
    services: WorkflowServices;
    ref: Workflows.ExecutionRef;
    limits?: Runtime.ExecutionLimits;
    definitionDigest: string;
    active: Execution['active'];
    waiting: Execution['waits'];
    getExecution(): Execution | undefined;
    record(outcome: Runtime.ManagedOutcome<unknown>): void;
  },
): Workflows.StepContext {
  const { services, ref, limits, definitionDigest, active, waiting, getExecution, record } =
    options;
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
    const execution = getExecution();
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
    record(outcome);
    return outcome;
  };
  const makeStepContext = (invocation: OperationContext): Workflows.StepContext => {
    const scoped: Workflows.StepContext = {
      execution: ref,
      signal: invocation.signal,
      limits: limits ?? {},
      script: (identity, input) =>
        memoize(identity, input as unknown as Contracts.Json, async () => {
          const outcome = services.scripts
            ? await runHandle(await services.scripts.execute(input, invocation))
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
          services.model
            ? runHandle(await services.model.invoke(input, invocation))
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
            services.runs
              ? runHandle(await services.runs.start(input, invocation))
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
            : services.results
              ? services.results.submit(input, invocation)
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
            if (!services.waits)
              return fail('workflow.waits', 'Wait service not installed', 'unsupported');
            const opened = await services.waits.open(
              {
                ...input,
                bindingDigest: await digest({
                  definition: definitionDigest,
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
              const execution = getExecution();
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
        if (!entry || !services.waits)
          return fail('workflow.ticket', 'Ticket not owned by this execution');
        const response = await invocation.wait(
          services.waits.wait(entry.ticket, entry.schema, invocation),
        );
        entry.ticket = {
          ...entry.ticket,
          state: response.ok ? 'resolved' : invocation.signal.aborted ? 'cancelled' : 'expired',
        };
        return response;
      },
    };
    stepScopes.set(scoped, makeStepContext);
    return scoped;
  };
  const stepContext = makeStepContext(operationContext);

  return stepContext;
}
