import { fail, ok } from '@slop-lab/part/contracts/index.js';
import type {
  Composition,
  Contracts,
  PipelineV1,
  Workflows,
} from '@slop-lab/part/reference/index.js';
export const handlersPoint: Composition.ExtensionPoint<PipelineV1.InstalledStepHandler> = {
  id: 'part.pipeline/handlers',
  owner: 'part/workflow-pipeline-v1',
  contractVersion: 1,
  kind: 'registry',
  scope: 'runtime',
};
export interface Handler {
  id: string;
  version: number;
  input: Contracts.Schema<Contracts.Json>;
  output: Contracts.Schema<Contracts.Json>;
  config: Contracts.Schema<Contracts.Json>;
  requires: readonly string[];
  effects: 'read' | 'write' | 'external' | 'unknown';
  execute(
    input: Contracts.Json,
    config: Contracts.Json,
    identity: Workflows.CallIdentity,
    context: Workflows.StepContext,
  ): Promise<Contracts.Result<Contracts.Json>>;
}
export const bindings = new WeakMap<object, Handler>();
export function installStepHandler<I extends Contracts.Json, O extends Contracts.Json>(
  handler: PipelineV1.StepHandler<I, O>,
): PipelineV1.InstalledStepHandler {
  const token = {};
  bindings.set(token, {
    ...handler,
    input: handler.input as Contracts.Schema<Contracts.Json>,
    output: handler.output as Contracts.Schema<Contracts.Json>,
    async execute(input, config, identity, context) {
      const checked = handler.input.validate(input);
      if (!checked.ok) return fail('pipeline.handler-input', 'Handler input validation failed');
      const configured = handler.config.validate(config);
      if (!configured.ok)
        return fail('pipeline.handler-config', 'Handler config validation failed');
      const result = await handler.execute(checked.value, configured.value, identity, context);
      if (!result.ok) return result;
      const output = handler.output.validate(result.value);
      return output.ok
        ? ok(output.value)
        : fail(
            'pipeline.handler-output',
            'Handler output validation failed',
            'validation',
            handler.effects === 'read' ? 'not-applied' : 'applied',
          );
    },
  });
  return Object.freeze({ id: handler.id, version: handler.version, localBinding: token });
}
