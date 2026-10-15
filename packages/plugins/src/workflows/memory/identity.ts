import { digest } from '@slop-lab/part/contracts';
import type { Contracts, Workflows } from '@slop-lab/part/reference';
export async function callIdentity(
  execution: Workflows.ExecutionRef,
  stepKey: string,
  input: Contracts.Json,
  iterationPath: readonly (string | number)[] = [],
  attempt = 1,
): Promise<Workflows.CallIdentity> {
  return { workflow: execution, stepKey, iterationPath, attempt, inputDigest: await digest(input) };
}
