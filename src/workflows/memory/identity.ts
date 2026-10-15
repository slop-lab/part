import { digest } from '../../contracts/index.js';
import type { Contracts } from '../../reference/contracts.js';
import type { Workflows } from '../../reference/workflows.js';
export async function callIdentity(
  execution: Workflows.ExecutionRef,
  stepKey: string,
  input: Contracts.Json,
  iterationPath: readonly (string | number)[] = [],
  attempt = 1,
): Promise<Workflows.CallIdentity> {
  return { workflow: execution, stepKey, iterationPath, attempt, inputDigest: await digest(input) };
}
