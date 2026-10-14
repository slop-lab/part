import type { Contracts as C, Workflows as W } from './reference.js';
import { ok, fail, digest } from './contracts.js';
import { createMemoryWorkflowEngine } from './workflow-memory.js';
import type { WorkflowServices } from './workflow-memory.js';
export function createCodeEngine(
  definitions: readonly { definition: W.CodeDefinition<C.Json, C.Json>; digest: string }[],
  services: WorkflowServices,
): C.Result<W.Engine> {
  const registry = new Map(
    definitions.map((d) => [d.definition.id, { ...d, definition: { ...d.definition } }]),
  );
  if (registry.size !== definitions.length)
    return fail('workflow.code-duplicate', 'Duplicate code definition');
  return ok(
    createMemoryWorkflowEngine({
      descriptor: {
        id: 'part/workflow-code-v1',
        version: '1',
        forms: ['code'],
        formats: [{ id: 'part.code', versions: ['1'] }],
        capabilities: {
          revision: '1',
          entries: [
            {
              id: 'part/workflow.code',
              contractVersion: 1,
              status: 'supported',
              implementedBy: 'part/workflow-code-v1',
              constraints: { replay: 'none' },
            },
          ],
        },
      },
      services,
      profileIds: ['default'],
      async compile(request) {
        const installed = registry.get(request.definition.id);
        if (!installed)
          return fail('workflow.definition', 'Code definition not installed', 'unsupported');
        if (installed.digest !== request.definition.digest)
          return fail('workflow.digest', 'Code definition digest mismatch', 'conflict');
        if (installed.definition.replay !== 'none')
          return fail('workflow.replay', 'Code replay is not implemented', 'unsupported');
        return ok({
          input: installed.definition.input,
          output: installed.definition.output,
          execute: (input, steps) => installed.definition.execute(input, steps),
        });
      },
    }),
  );
}

export async function defineCodeWorkflow<I extends C.Json, O extends C.Json>(
  definition: W.CodeDefinition<I, O>,
) {
  return {
    definition,
    digest: await digest({
      id: definition.id,
      version: definition.version,
      input: { ...definition.input.ref },
      output: { ...definition.output.ref },
      replay: definition.replay,
      source: definition.execute.toString(),
    }),
  };
}
