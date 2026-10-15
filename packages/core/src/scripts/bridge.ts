import type { Contracts } from '../reference/contracts.js';
import type { Scripts } from '../reference/scripts.js';
export interface BridgeMethod {
  readonly profileRequired?: boolean;
  invoke(
    params: Contracts.Json,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.CommandReceipt>;
}
export interface ManagedBridge extends Scripts.BridgeHost {
  authenticate(
    grantId: string,
    credential: string,
    audience: string,
  ): Contracts.Result<Contracts.InvocationContext>;
  grant(
    grantId: string,
    context: Contracts.InvocationContext,
  ): Contracts.Result<Scripts.BridgeGrant>;
  credential(grantId: string, context: Contracts.InvocationContext): Contracts.Result<string>;
  close(): void;
}
