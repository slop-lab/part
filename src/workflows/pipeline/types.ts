import type { Composition } from '../../reference/composition.js';
import type { Contracts } from '../../reference/contracts.js';
import type { PipelineV1 } from '../../reference/pipeline-v1.js';
import type { Runtime } from '../../reference/runtime.js';
import type { Skills } from '../../reference/skills.js';
import type { WorkflowServices } from '../memory/types.js';
export interface PipelineOptions {
  definitions: readonly PipelineV1.Definition[];
  schemas: readonly Contracts.Schema<Contracts.Json>[];
  services: WorkflowServices;
  handlers?: readonly PipelineV1.InstalledStepHandler[];
  agents?: Readonly<Record<string, { driver: string; composition: Composition.CompositionHandle }>>;
  boundary?: Runtime.InvocationBoundary;
  capabilities?: Contracts.CapabilitySet;
  skills?: {
    service: Skills.Service;
    bind(
      input: Contracts.Json,
      activations: readonly Skills.Activation[],
    ): Contracts.Result<Contracts.Json>;
  };
}
export type Block = { sorted: PipelineV1.Step[]; steps: Map<string, PipelineV1.Step> };
