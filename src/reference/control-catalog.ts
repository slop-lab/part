import type { Contracts } from './contracts.js';
import type { Runtime } from './runtime.js';
import type { Workflows } from './workflows.js';
export namespace ControlCatalog {
  /** Proposed built-in wire inputs. A host resolves composition/profile references locally. */
  export interface RunStartInput {
    readonly driverId: string;
    readonly input: Contracts.Json;
    readonly composition: { readonly id: string; readonly revision: string };
    readonly limits?: Runtime.ExecutionLimits;
    readonly history?: {
      readonly sessionId: string;
      readonly branchId: string;
      readonly expectedHead?: string;
    };
  }
  export interface RunCancelInput {
    readonly run: Contracts.EntityRef;
    readonly reason: string;
  }
  export interface WaitResponseInput {
    readonly ticketId: string;
    readonly expectedRevision: string;
    readonly response: Contracts.Json;
  }
  export interface HistoryForkInput {
    readonly branchId: string;
    readonly expectedRevision: string;
    readonly atEntry?: string;
  }
  export interface InspectInput {
    readonly target: Contracts.EntityRef;
    readonly view: string;
  }
  /** Wire selects already registered/authorized definitions; no executable module bytes or local handle. */
  export interface WorkflowStartInput {
    readonly engineId: string;
    readonly definition: { readonly id: string; readonly digest: string };
    readonly profileId: string;
    readonly composition: { readonly id: string; readonly revision: string };
    readonly input: Contracts.Json;
    readonly limits?: Runtime.ExecutionLimits;
    readonly requiredControl: 'instruction-only' | 'runner-enforced';
    readonly requiredCapabilities: readonly string[];
  }
  export interface WorkflowActionInput {
    readonly execution: Workflows.ExecutionRef;
    readonly actionId: string;
    readonly actionVersion: number;
    readonly expectedRevision: string;
    readonly input: Contracts.Json;
  }
}
