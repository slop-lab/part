import { digest, fail, ok } from '../../contracts/index.js';
import type { Contracts } from '../../reference/contracts.js';
import type { Skills } from '../../reference/skills.js';
import type { Workflows } from '../../reference/workflows.js';
import { createOperations } from '../../runtime/operations.js';
import { createMemoryWorkflowEngine } from '../memory/index.js';
import { createBlockCompiler } from './compile.js';
import { createPipelineExecutor } from './execute.js';
import type { Handler } from './handlers.js';
import { bindings } from './handlers.js';
import type { PipelineOptions } from './types.js';
import { jsonValid, valueValid } from './values.js';
export { handlersPoint, installStepHandler } from './handlers.js';
export function createPipelineEngine(options: PipelineOptions): Contracts.Result<Workflows.Engine> {
  options = {
    ...options,
    services: { ...options.services },
    agents: options.agents
      ? Object.fromEntries(
          Object.entries(options.agents).map(([id, profile]) => [id, { ...profile }]),
        )
      : undefined,
    capabilities: options.capabilities ? structuredClone(options.capabilities) : undefined,
    skills: options.skills ? { ...options.skills } : undefined,
  };
  const definitions = new Map(options.definitions.map((d) => [d.id, structuredClone(d)])),
    schemas = new Map(options.schemas.map((s) => [`${s.ref.id}@${s.ref.version}`, s])),
    handlers = new Map<string, Handler>();
  if (definitions.size !== options.definitions.length || schemas.size !== options.schemas.length)
    return fail('pipeline.duplicate', 'Duplicate definition or schema');
  for (const installed of options.handlers ?? []) {
    const handler =
      installed.localBinding && typeof installed.localBinding === 'object'
        ? bindings.get(installed.localBinding)
        : undefined;
    if (
      !handler ||
      installed.id !== handler.id ||
      installed.version !== handler.version ||
      handlers.has(installed.id)
    )
      return fail('pipeline.handler', 'Invalid or duplicate handler');
    handlers.set(handler.id, handler);
  }
  const operations = options.services.operations ?? createOperations();
  const schemaFor = (ref: Contracts.SchemaRef) =>
    ref && typeof ref.id === 'string' && Number.isSafeInteger(ref.version)
      ? schemas.get(`${ref.id}@${ref.version}`)
      : undefined;
  return ok(
    createMemoryWorkflowEngine({
      descriptor: {
        id: 'part/workflow-pipeline-v1',
        version: '1',
        forms: ['pipeline'],
        formats: [{ id: 'part.pipeline', versions: ['1'] }],
        capabilities: {
          revision: '1',
          entries: [
            {
              id: 'part/workflow.pipeline',
              contractVersion: 1,
              status: 'supported',
              implementedBy: 'part/workflow-pipeline-v1',
              constraints: {
                steps: [
                  'validate',
                  'wait',
                  'assert',
                  'script',
                  'agent',
                  'extension',
                  'branch',
                  'repeat',
                  'parallel',
                ],
                replay: 'none',
              },
            },
          ],
        },
      },
      services: { ...options.services, operations },
      profileIds: ['default'],
      async compile(request, caller) {
        const listedSkills = options.skills
          ? await options.skills.service.list(caller)
          : ok([] as readonly Skills.Descriptor[]);
        if (!listedSkills.ok) return listedSkills;
        const installedSkills = listedSkills.value;
        const definition = definitions.get(request.definition.id);
        if (!definition)
          return fail('pipeline.definition', 'Pipeline definition not installed', 'unsupported');
        if (
          !jsonValid(definition) ||
          definition.format !== 'part.pipeline' ||
          definition.version !== 1 ||
          !Array.isArray(definition.steps) ||
          !definition.steps.length ||
          !valueValid(definition.result)
        )
          return fail('pipeline.definition', 'Invalid pipeline definition');
        if (
          Object.keys(definition).some(
            (k) => !['id', 'format', 'version', 'input', 'output', 'steps', 'result'].includes(k),
          )
        )
          return fail('pipeline.field', 'Unknown required definition field', 'unsupported');
        if ((await digest(definition as unknown as Contracts.Json)) !== request.definition.digest)
          return fail('pipeline.digest', 'Pipeline digest mismatch', 'conflict');
        const input = schemaFor(definition.input),
          output = schemaFor(definition.output);
        if (!input || !output)
          return fail('pipeline.schema', 'Input/output schema not installed', 'unsupported');
        const { blocks, compileBlock } = createBlockCompiler(
          options,
          handlers,
          schemaFor,
          installedSkills,
        );
        const compiled = compileBlock(definition.steps);
        if (!compiled.ok) return compiled;
        if ('step' in definition.result && !compiled.value.steps.has(definition.result.step))
          return fail('pipeline.result', 'Unknown result step');
        const mainBlock = compiled.value,
          finalValue = definition.result;
        return ok({
          input,
          output,
          execute: createPipelineExecutor(
            options,
            handlers,
            schemaFor,
            operations,
            blocks,
            mainBlock,
            finalValue,
          ),
        });
      },
    }),
  );
}
