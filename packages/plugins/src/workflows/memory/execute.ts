import { provenance } from '@slop-lab/part/context/index.js';
import { fail, freeze } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Runtime, Workflows } from '@slop-lab/part/reference/index.js';
import type { OperationContext } from '@slop-lab/part/runtime/index.js';
import { combineEffects } from '@slop-lab/part/runtime/index.js';
import { createStepContext } from './context.js';
import type { Execution, PreparedRunner, WorkflowServices } from './types.js';
export async function executeWorkflow(
  operationContext: OperationContext,
  options: {
    services: WorkflowServices;
    ref: Workflows.ExecutionRef;
    request: Workflows.StartRequest;
    runner: PreparedRunner;
    input: Contracts.Json;
    active: Execution['active'];
    waiting: Execution['waits'];
    getExecution(): Execution | undefined;
  },
): Promise<Runtime.ManagedOutcome<Contracts.Json>> {
  const { services, ref, request, runner, input, active, waiting, getExecution } = options;

  let effect: Contracts.EffectState = 'not-attempted';
  const commit: Contracts.CommitEvidence[] = [];
  const record = (outcome: Runtime.ManagedOutcome<unknown>) => {
    effect = combineEffects(effect, outcome.effect);
    commit.push(...outcome.commit);
  };
  const stepContext = createStepContext(operationContext, {
    services,
    ref,
    limits: request.limits,
    definitionDigest: request.prepared.definition.digest,
    active,
    waiting,
    getExecution,
    record,
  });
  let result: Contracts.Result<Contracts.Json>;
  try {
    result = await runner.execute(structuredClone(input), stepContext, operationContext, record);
  } catch {
    return {
      phase: 'failed',
      error: fail('workflow.exception', 'Workflow definition failed', 'internal', 'unknown').error,
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
  const execution = getExecution();
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
}
