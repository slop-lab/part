import type { Contracts } from './contracts.js';
export namespace Testing {
  export interface Candidate {
    readonly id: string;
    readonly revision: string;
    readonly components: readonly string[];
    readonly config: Contracts.Json;
  }
  export interface Evidence {
    readonly testId: string;
    readonly candidate: Candidate;
    readonly result: 'pass' | 'fail' | 'not-run' | 'unsupported';
    readonly effectsObserved: Contracts.Json;
    readonly logs: readonly string[];
    readonly measurements?: Contracts.Json;
  }
  export interface ContractSuite {
    readonly id: string;
    run(candidate: Candidate): Promise<readonly Evidence[]>;
  }
}
