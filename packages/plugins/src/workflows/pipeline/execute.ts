import { canonical, digest, fail, isJson, ok } from '@slop-lab/part/contracts';
import type { Contracts, PipelineV1, Skills, Workflows } from '@slop-lab/part/reference';
import type { OperationContext } from '@slop-lab/part/runtime';
import { createBoundary, managedAttempt, reserve } from '@slop-lab/part/runtime';
import { scopeStepContext } from '../memory/context.js';
import { callIdentity } from '../memory/identity.js';
import type { PreparedRunner, WorkflowServices } from '../memory/types.js';
import type { Handler } from './handlers.js';
import type { Block, PipelineOptions } from './types.js';
import { pointer } from './values.js';
export function createPipelineExecutor(
  options: PipelineOptions,
  handlers: ReadonlyMap<string, Handler>,
  schemaFor: (ref: Contracts.SchemaRef) => Contracts.Schema<Contracts.Json> | undefined,
  operations: NonNullable<WorkflowServices['operations']>,
  blocks: WeakMap<object, Block>,
  mainBlock: Block,
  finalValue: PipelineV1.Value,
): PreparedRunner['execute'] {
  return async function execute(input, context, invocation, record) {
    async function runBlock(
      block: Block,
      context: Workflows.StepContext,
      invocation: OperationContext,
      path: readonly (string | number)[],
      selection?: PipelineV1.Value,
    ): Promise<Contracts.Result<Contracts.Json>> {
      const results = new Map<string, Contracts.Json>();
      const read = (value: PipelineV1.Value): Contracts.Result<Contracts.Json> =>
        'literal' in value
          ? ok(structuredClone(value.literal))
          : 'input' in value
            ? pointer(input, value.input)
            : results.has(value.step)
              ? pointer(results.get(value.step)!, value.pointer)
              : fail('pipeline.value', 'Step result is unavailable');
      const identify = (
        execution: Workflows.ExecutionRef,
        stepKey: string,
        value: Contracts.Json,
      ) => callIdentity(execution, stepKey, value, path);
      async function runStep(
        step: PipelineV1.Step,
        context: Workflows.StepContext,
        invocation: OperationContext,
      ): Promise<Contracts.Result<Contracts.Json>> {
        if (context.signal.aborted)
          return fail('pipeline.cancelled', 'Pipeline cancelled', 'cancelled');
        let result: Contracts.Result<Contracts.Json>;
        if (step.kind === 'validate' || step.kind === 'assert') {
          result = read(step.value);
          if (!result.ok) return result;
          if (step.kind === 'validate') {
            const checked = schemaFor(step.schema)!.validate(result.value);
            if (!checked.ok) return fail('pipeline.validation', 'Validation step failed');
            result = ok(checked.value);
          } else if (canonical(result.value) !== canonical(step.equals))
            return fail('pipeline.assert', 'Assertion failed');
        } else if (step.kind === 'wait') {
          const binding = read(step.binding);
          if (!binding.ok) return binding;
          const responseSchema = schemaFor(step.response)!,
            bindingDigest = await digest(binding.value),
            spec = {
              type: 'part/pipeline-wait',
              responseSchema,
              presentation: { prompt: step.prompt },
              bindingDigest,
            };
          const identity = await identify(context.execution, step.id, {
            type: spec.type,
            responseSchema: { ...responseSchema.ref },
            presentation: spec.presentation,
            bindingDigest,
          });
          const ticket = await context.wait(identity, spec);
          if (!ticket.ok) return ticket;
          result = await context.response(ticket.value);
        } else if (step.kind === 'script') {
          const stdin = read(step.stdin);
          if (!stdin.ok) return stdin;
          const request = { ...step.request, stdin: stdin.value },
            identity = await identify(
              context.execution,
              step.id,
              request as unknown as Contracts.Json,
            );
          const outcome = await context.script(identity, request);
          if (outcome.phase !== 'completed')
            return fail(
              'pipeline.script',
              'Script step failed',
              outcome.phase === 'cancelled' ? 'cancelled' : 'internal',
              outcome.effect,
            );
          if (outcome.result.captured?.kind !== 'inline')
            return fail('pipeline.capture', 'Script step requires explicit JSON capture');
          result = ok(outcome.result.captured.value);
        } else if (step.kind === 'agent') {
          const value = read(step.input);
          if (!value.ok) return value;
          const activations: Skills.Activation[] = [];
          let boundInput = value.value;
          try {
            for (const skill of step.skills ?? []) {
              const activated = await options.skills!.service.activate(
                {
                  skillId: skill.id,
                  packageDigest: skill.digest,
                  owner: {
                    owner: 'part/workflow-pipeline-v1',
                    kind: 'step',
                    id: invocation.scope.id,
                  },
                  purpose: 'Managed pipeline agent input',
                  scope: 'invocation',
                },
                invocation,
              );
              if (!activated.ok) return activated;
              activations.push(activated.value);
            }
            if (activations.length) {
              const bound = options.skills!.bind(boundInput, activations);
              if (!bound.ok) return bound;
              boundInput = bound.value;
            }
            const profile = options.agents![step.profile]!;
            const identity = await identify(context.execution, step.id, {
              driver: profile.driver,
              input: boundInput,
              compositionRevision: profile.composition.inspection.revision,
            });
            const outcome = await context.agent(identity, {
              driver: profile.driver,
              input: boundInput,
              composition: profile.composition,
            });
            result =
              outcome.phase === 'completed' && isJson(outcome.result)
                ? ok(outcome.result)
                : fail('pipeline.agent', 'Agent step failed', 'internal', outcome.effect);
          } finally {
            for (const activation of activations.reverse())
              await options.skills!.service.deactivate(activation.id, {
                ...invocation,
                signal: new AbortController().signal,
              });
          }
        } else if (step.kind === 'extension') {
          const value = read(step.input);
          if (!value.ok) return value;
          const handler = handlers.get(step.handler)!;
          if (!handler.input.validate(value.value).ok)
            return fail('pipeline.handler-input', 'Handler input validation failed');
          const identity = await identify(context.execution, step.id, value.value);
          const outcome = await managedAttempt<Contracts.Json>(
            options.boundary ?? createBoundary(),
            {
              operationId: invocation.scope.id,
              attemptId: crypto.randomUUID(),
              target: handler.id,
              executor: 'part/pipeline-handler',
              inputDigest: await digest({ input: value.value, config: step.config }),
              scopeDigest: await digest({
                principal: invocation.principal,
                scope: { ...invocation.scope },
              }),
              compositionRevision: '1',
              classification: handler.effects,
            },
            async () => {
              const budget = reserve(invocation, 'maxExecutorAttempts');
              if (!budget.ok)
                return { kind: 'failed', error: budget.error, effect: 'not-attempted' };
              const executed = await handler.execute(value.value, step.config, identity, context);
              return executed.ok
                ? {
                    kind: 'returned',
                    value: executed.value,
                    effect: handler.effects === 'read' ? 'not-applied' : 'applied',
                  }
                : {
                    kind: 'failed',
                    error: executed.error,
                    effect:
                      executed.error.effect ??
                      (handler.effects === 'read' ? 'not-applied' : 'unknown'),
                  };
            },
            invocation,
          );
          record(outcome);
          result =
            outcome.phase === 'completed'
              ? ok(outcome.result)
              : fail('pipeline.handler', 'Handler step failed', 'internal', outcome.effect);
        } else if (step.kind === 'branch') {
          const value = read(step.value);
          if (!value.ok) return value;
          const index = step.cases.findIndex((c) => canonical(c.equals) === canonical(value.value));
          const selected = index >= 0 ? step.cases[index]!.run : step.otherwise;
          if (!selected) return fail('pipeline.branch', 'No branch case matched');
          result = await runBlock(blocks.get(selected)!, context, invocation, [
            ...path,
            step.id,
            index >= 0 ? index : 'otherwise',
          ]);
        } else if (step.kind === 'repeat') {
          for (let iteration = 0; iteration < step.maxIterations; iteration++) {
            const checked = await runBlock(
              blocks.get(step.body)!,
              context,
              invocation,
              [...path, step.id, iteration],
              step.until.value,
            );
            if (!checked.ok) return checked;
            const values = checked.value as {
              condition: Contracts.Json;
              result: Contracts.Json;
            };
            if (canonical(values.condition) === canonical(step.until.equals))
              return ok(values.result);
          }
          return fail('pipeline.repeat', 'Repeat exceeded maxIterations');
        } else if (step.kind === 'parallel') {
          const outputs: Contracts.Result<Contracts.Json>[] = new Array(step.branches.length);
          const cancellation = new AbortController();
          let cursor = 0,
            failed = false;
          const workers = Array.from(
            { length: Math.min(step.maxConcurrency, step.branches.length) },
            async () => {
              while (
                cursor < step.branches.length &&
                !(failed && step.onError === 'cancel-and-join')
              ) {
                const index = cursor++,
                  branch = step.branches[index]!;
                const child = await operations.begin<Contracts.Json>(
                  {
                    kind: 'part/pipeline-branch',
                    childPolicy: 'attached',
                    retryOwner: 'part/workflow-pipeline-v1',
                  },
                  async (c) => {
                    const value = await runBlock(
                      blocks.get(branch)!,
                      scopeStepContext(context, c),
                      c,
                      [...path, step.id, index],
                    );
                    return value.ok
                      ? {
                          phase: 'completed',
                          result: value.value,
                          effect: 'not-applicable',
                          commit: [],
                          unsettledChildren: [],
                        }
                      : {
                          phase: 'failed',
                          error: value.error,
                          effect: value.error.effect ?? 'not-attempted',
                          commit: [],
                          unsettledChildren: [],
                        };
                  },
                  {
                    ...invocation,
                    signal: AbortSignal.any([invocation.signal, cancellation.signal]),
                  },
                );
                if (!child.ok) outputs[index] = child;
                else {
                  const outcome = await child.value.done;
                  if (outcome.phase === 'abandoned') record(outcome);
                  outputs[index] =
                    outcome.phase === 'completed'
                      ? ok(outcome.result)
                      : fail(
                          'pipeline.parallel-child',
                          'Parallel branch failed',
                          outcome.phase === 'cancelled' ? 'cancelled' : 'internal',
                          outcome.effect,
                        );
                }
                if (!outputs[index]!.ok) {
                  failed = true;
                  if (step.onError === 'cancel-and-join')
                    cancellation.abort('parallel-branch-failed');
                }
              }
            },
          );
          await Promise.all(workers);
          if (failed)
            return fail('pipeline.parallel', 'One or more required parallel branches failed');
          result = ok(outputs.map((value) => (value as { ok: true; value: Contracts.Json }).value));
        } else return fail('pipeline.kind', 'Unsupported step', 'unsupported');
        return result;
      }
      for (const step of block.sorted) {
        if (context.signal.aborted)
          return fail('pipeline.cancelled', 'Pipeline cancelled', 'cancelled');
        const deadlines = [
          invocation.deadline ? Date.parse(invocation.deadline) : Infinity,
          step.timeoutMs ? Date.now() + step.timeoutMs : Infinity,
        ];
        const deadline = Math.min(...deadlines);
        const child = await operations.begin<Contracts.Json>(
          {
            kind: 'part/pipeline-step',
            childPolicy: 'attached',
            retryOwner: 'part/workflow-pipeline-v1',
          },
          async (c) => {
            const result = await runStep(step, scopeStepContext(context, c), c);
            return result.ok
              ? {
                  phase: 'completed',
                  result: result.value,
                  effect: 'not-applicable',
                  commit: [],
                  unsettledChildren: [],
                }
              : {
                  phase: 'failed',
                  error: result.error,
                  effect: result.error.effect ?? 'not-attempted',
                  commit: [],
                  unsettledChildren: [],
                };
          },
          {
            ...invocation,
            ...(Number.isFinite(deadline) ? { deadline: new Date(deadline).toISOString() } : {}),
          },
        );
        if (!child.ok) return child;
        const outcome = await child.value.done;
        if (outcome.phase === 'abandoned') record(outcome);
        if (outcome.phase !== 'completed')
          return fail(
            'pipeline.step-failed',
            'Required pipeline step failed',
            outcome.phase === 'cancelled' ? 'cancelled' : 'internal',
            outcome.effect,
          );
        results.set(step.id, structuredClone(outcome.result));
      }
      const last = results.get(block.sorted.at(-1)!.id)!;
      if (selection) {
        const condition = read(selection);
        return condition.ok ? ok({ condition: condition.value, result: last }) : condition;
      }
      return block === mainBlock ? read(finalValue) : ok(last);
    }
    return runBlock(mainBlock, context, invocation, []);
  };
}
