/** @public */
import { digest, fail, isJson, ok } from '@slop-lab/part/contracts';
import type { Composition, Contracts, Workflows } from '@slop-lab/part/reference';
import { callIdentity } from './memory/identity.js';
import { createMemoryWorkflowEngine } from './memory/index.js';
import type { WorkflowServices } from './memory/types.js';
export interface RecipeDefinition {
  readonly id: string;
  readonly format: 'part.recipe';
  readonly version: 1;
  readonly input: Contracts.SchemaRef;
  readonly output: Contracts.SchemaRef;
  readonly agentProfile: string;
  readonly maxAttempts: number;
  readonly retry: 'never' | 'read-only-validation';
}
/** A recipe retries only explicitly declared read-only agent validation, never publish effects. */
export function createRecipeEngine(options: {
  definitions: readonly RecipeDefinition[];
  schemas: readonly Contracts.Schema<Contracts.Json>[];
  agents: Readonly<
    Record<
      string,
      {
        driver: string;
        composition: Composition.CompositionHandle;
        effects: 'read' | 'write' | 'unknown';
      }
    >
  >;
  services: WorkflowServices;
  check?: (
    output: Contracts.Json,
    context: Workflows.StepContext,
  ) => Promise<Contracts.Result<Contracts.Json>>;
}): Contracts.Result<Workflows.Engine> {
  const definitions = new Map(options.definitions.map((d) => [d.id, structuredClone(d)]));
  const schemas = new Map(options.schemas.map((s) => [`${s.ref.id}@${s.ref.version}`, s]));
  const agents = { ...options.agents };
  if (definitions.size !== options.definitions.length || schemas.size !== options.schemas.length)
    return fail('recipe.duplicate', 'Duplicate recipe or schema');
  return ok(
    createMemoryWorkflowEngine({
      descriptor: {
        id: 'part/workflow-recipe-v1',
        version: '1',
        forms: ['recipe'],
        formats: [{ id: 'part.recipe', versions: ['1'] }],
        capabilities: {
          revision: '1',
          entries: [
            {
              id: 'part/workflow.recipe',
              contractVersion: 1,
              implementedBy: 'part/workflow-recipe-v1',
              status: 'supported',
              constraints: { retry: 'explicit-read-only-validation', maxAttempts: 16 },
            },
          ],
        },
      },
      services: options.services,
      profileIds: ['default'],
      async compile(request) {
        const definition = definitions.get(request.definition.id);
        if (
          !definition ||
          !isJson(definition) ||
          definition.format !== 'part.recipe' ||
          definition.version !== 1 ||
          Object.keys(definition).some(
            (key) =>
              ![
                'id',
                'format',
                'version',
                'input',
                'output',
                'agentProfile',
                'maxAttempts',
                'retry',
              ].includes(key),
          )
        )
          return fail('recipe.definition', 'Invalid or uninstalled recipe');
        if ((await digest(definition as unknown as Contracts.Json)) !== request.definition.digest)
          return fail('recipe.digest', 'Recipe digest mismatch', 'conflict');
        const input = schemas.get(`${definition.input.id}@${definition.input.version}`),
          output = schemas.get(`${definition.output.id}@${definition.output.version}`),
          agent = Object.hasOwn(agents, definition.agentProfile)
            ? agents[definition.agentProfile]
            : undefined;
        if (!input || !output || !agent || !options.services.runs)
          return fail(
            'recipe.requirement',
            'Recipe schema or agent profile unavailable',
            'unsupported',
          );
        if (
          !Number.isSafeInteger(definition.maxAttempts) ||
          definition.maxAttempts < 1 ||
          definition.maxAttempts > 16 ||
          !['never', 'read-only-validation'].includes(definition.retry) ||
          (definition.maxAttempts > 1 &&
            (definition.retry !== 'read-only-validation' || agent.effects !== 'read'))
        )
          return fail('recipe.retry', 'Retry requires an explicit read-only agent profile');
        return ok({
          input,
          output,
          async execute(value, steps) {
            for (let attempt = 1; attempt <= definition.maxAttempts; attempt++) {
              const identity = await callIdentity(
                steps.execution,
                'agent',
                {
                  driver: agent.driver,
                  input: value,
                  compositionRevision: agent.composition.inspection.revision,
                },
                [],
                attempt,
              );
              const outcome = await steps.agent(identity, {
                driver: agent.driver,
                composition: agent.composition,
                input: value,
              });
              if (outcome.phase !== 'completed')
                return fail(
                  'recipe.agent',
                  'Recipe agent failed; effects are not automatically retried',
                  'internal',
                  outcome.effect,
                );
              if (
                agent.effects === 'read' &&
                (outcome.effect === 'applied' || outcome.effect === 'unknown')
              )
                return fail(
                  'recipe.effects',
                  'Read-only recipe profile produced write or unknown effect evidence',
                  'internal',
                  outcome.effect,
                );
              const checked = output.validate(outcome.result);
              if (!checked.ok) {
                if (attempt < definition.maxAttempts) continue;
                return fail('recipe.validation', 'Recipe output validation failed');
              }
              const encoded = output.codec?.encode(checked.value);
              if (!encoded?.ok) return fail('recipe.codec', 'Recipe output codec unavailable');
              if (options.check) {
                const result = await options.check(encoded.value, steps);
                if (!result.ok) {
                  if (attempt < definition.maxAttempts) continue;
                  return result;
                }
                return result;
              }
              return encoded;
            }
            return fail('recipe.attempts', 'Recipe attempts exhausted');
          },
        });
      },
    }),
  );
}
