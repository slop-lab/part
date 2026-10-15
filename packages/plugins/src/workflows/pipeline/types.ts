import type {
  Composition,
  Contracts,
  PipelineV1,
  Runtime,
  Skills,
} from '@slop-lab/part/reference/index.js';
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
