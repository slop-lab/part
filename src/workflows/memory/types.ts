import type { Contracts } from '../../reference/contracts.js';
import type { Model } from '../../reference/model.js';
import type { Results } from '../../reference/results.js';
import type { Runtime } from '../../reference/runtime.js';
import type { Scripts } from '../../reference/scripts.js';
import type { Workflows } from '../../reference/workflows.js';
import type { OperationContext, Operations } from '../../runtime/operations.js';
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
export interface Execution {
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
