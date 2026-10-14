import type {
  Contracts as C,
  PipelineV1 as P,
  Workflows as W,
  Composition as L,
  Runtime as R,
} from './reference.js';
import { ok, fail, digest, canonical, isJson, isJsonObject } from './contracts.js';
import { createMemoryWorkflowEngine, callIdentity } from './workflow-memory.js';
import { createBoundary, managedAttempt } from './runtime.js';
import { reserve } from './model.js';
import type { WorkflowServices } from './workflow-memory.js';
export const handlersPoint: L.ExtensionPoint<P.InstalledStepHandler> = {
  id: 'part.pipeline/handlers',
  owner: 'part/workflow-pipeline-v1',
  contractVersion: 1,
  kind: 'registry',
  scope: 'runtime',
};
interface Handler {
  id: string;
  version: number;
  input: C.Schema<C.Json>;
  output: C.Schema<C.Json>;
  config: C.Schema<C.Json>;
  requires: readonly string[];
  effects: 'read' | 'write' | 'external' | 'unknown';
  execute(
    input: C.Json,
    config: C.Json,
    identity: W.CallIdentity,
    context: W.StepContext,
  ): Promise<C.Result<C.Json>>;
}
const bindings = new WeakMap<object, Handler>();
export function installStepHandler<I extends C.Json, O extends C.Json>(
  handler: P.StepHandler<I, O>,
): P.InstalledStepHandler {
  const token = {};
  bindings.set(token, {
    ...handler,
    input: handler.input as C.Schema<C.Json>,
    output: handler.output as C.Schema<C.Json>,
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
const objectValid = (value: unknown): boolean => isJsonObject(value);
const jsonValid = (value: unknown): boolean => isJson(value);
function pointer(value: C.Json, path: string): C.Result<C.Json> {
  if (!path) return ok(value);
  if (!path.startsWith('/') || /~(?![01])/u.test(path))
    return fail('pipeline.pointer', 'Invalid JSON Pointer');
  let current = value;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key) ||
      (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      return fail('pipeline.pointer', `JSON Pointer target missing: ${path}`);
    current = (current as Record<string, C.Json>)[key]!;
  }
  return ok(current);
}
function valueValid(value: unknown): value is P.Value {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 1 &&
      ('literal' in value ||
        (typeof value.input === 'string' &&
          (value.input === '' ||
            (value.input.startsWith('/') && !/~(?![01])/u.test(value.input)))))) ||
    (keys.length === 2 &&
      typeof value.step === 'string' &&
      typeof value.pointer === 'string' &&
      (value.pointer === '' ||
        (value.pointer.startsWith('/') && !/~(?![01])/u.test(value.pointer))))
  );
}
export function createPipelineEngine(options: {
  definitions: readonly P.Definition[];
  schemas: readonly C.Schema<C.Json>[];
  services: WorkflowServices;
  handlers?: readonly P.InstalledStepHandler[];
  agents?: Readonly<Record<string, { driver: string; composition: L.CompositionHandle }>>;
  boundary?: R.InvocationBoundary;
}): C.Result<W.Engine> {
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
  const schemaFor = (ref: C.SchemaRef) =>
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
                steps: ['validate', 'wait', 'assert', 'script', 'agent', 'extension'],
                replay: 'none',
              },
            },
          ],
        },
      },
      services: options.services,
      profileIds: ['default'],
      async compile(request) {
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
        if ((await digest(definition as unknown as C.Json)) !== request.definition.digest)
          return fail('pipeline.digest', 'Pipeline digest mismatch', 'conflict');
        const input = schemaFor(definition.input),
          output = schemaFor(definition.output);
        if (!input || !output)
          return fail('pipeline.schema', 'Input/output schema not installed', 'unsupported');
        const steps = new Map<string, P.Step>(),
          ancestors = new Map<string, Set<string>>();
        for (const step of definition.steps) {
          if (
            !objectValid(step) ||
            typeof step.id !== 'string' ||
            !step.id ||
            !Array.isArray(step.after) ||
            step.after.some((id: unknown) => typeof id !== 'string') ||
            steps.has(step.id)
          )
            return fail('pipeline.step', 'Invalid or duplicate pipeline step');
          if (step.timeoutMs !== undefined)
            return fail(
              'pipeline.timeout',
              'Per-step timeouts are not supported by this subset',
              'unsupported',
            );
          const allowed: Record<string, string[]> = {
            validate: ['value', 'schema'],
            assert: ['value', 'equals'],
            wait: ['response', 'binding', 'prompt'],
            script: ['request', 'stdin'],
            agent: ['profile', 'input'],
            extension: ['handler', 'handlerVersion', 'input', 'config'],
          };
          if (!allowed[step.kind])
            return fail('pipeline.kind', `Unsupported pipeline step: ${step.kind}`, 'unsupported');
          if (
            Object.keys(step).some(
              (key) => !['id', 'kind', 'after', ...allowed[step.kind]!].includes(key),
            )
          )
            return fail('pipeline.field', `Unsupported step field in ${step.id}`, 'unsupported');
          if (
            (step.kind === 'validate' && (!valueValid(step.value) || !schemaFor(step.schema))) ||
            (step.kind === 'assert' && !valueValid(step.value)) ||
            (step.kind === 'wait' &&
              (!valueValid(step.binding) ||
                !schemaFor(step.response) ||
                !options.services.waits)) ||
            (step.kind === 'script' && (!valueValid(step.stdin) || !options.services.scripts)) ||
            (step.kind === 'agent' &&
              (!valueValid(step.input) ||
                !options.agents?.[step.profile] ||
                !options.services.runs)) ||
            (step.kind === 'extension' && !valueValid(step.input))
          )
            return fail(
              'pipeline.requirement',
              `Missing schema, value, or service in ${step.id}`,
              'unsupported',
            );
          if (step.kind === 'extension') {
            const handler = handlers.get(step.handler);
            if (!handler || handler.version !== step.handlerVersion || handler.requires.length)
              return fail(
                'pipeline.handler',
                'Handler/version/capability not installed',
                'unsupported',
              );
            if (!handler.config.validate(step.config).ok)
              return fail('pipeline.handler-config', 'Handler config validation failed');
          }
          steps.set(step.id, step);
        }
        const sorted: P.Step[] = [],
          remaining = new Set(steps.keys());
        while (remaining.size) {
          for (const id of remaining)
            for (const dependency of steps.get(id)!.after)
              if (!steps.has(dependency))
                return fail('pipeline.dependency', 'Unknown step dependency');
          const id = [...remaining]
            .sort()
            .find((id) => steps.get(id)!.after.every((parent) => !remaining.has(parent)));
          if (!id) return fail('pipeline.cycle', 'Pipeline dependency cycle');
          const step = steps.get(id)!,
            closure = new Set<string>();
          for (const parent of step.after) {
            closure.add(parent);
            for (const ancestor of ancestors.get(parent) ?? []) closure.add(ancestor);
          }
          ancestors.set(id, closure);
          sorted.push(step);
          remaining.delete(id);
        }
        for (const step of sorted) {
          const value =
            step.kind === 'validate' || step.kind === 'assert'
              ? step.value
              : step.kind === 'wait'
                ? step.binding
                : step.kind === 'script'
                  ? step.stdin
                  : step.kind === 'agent' || step.kind === 'extension'
                    ? step.input
                    : undefined;
          if (value && 'step' in value && !ancestors.get(step.id)!.has(value.step))
            return fail('pipeline.reference', 'Producer is not in dependency closure');
        }
        if ('step' in definition.result && !steps.has(definition.result.step))
          return fail('pipeline.result', 'Unknown result step');
        return ok({
          input,
          output,
          async execute(input, context, invocation, record) {
            const results = new Map<string, C.Json>();
            const read = (value: P.Value): C.Result<C.Json> =>
              'literal' in value
                ? ok(structuredClone(value.literal))
                : 'input' in value
                  ? pointer(input, value.input)
                  : results.has(value.step)
                    ? pointer(results.get(value.step)!, value.pointer)
                    : fail('pipeline.value', 'Step result is unavailable');
            for (const step of sorted) {
              if (context.signal.aborted)
                return fail('pipeline.cancelled', 'Pipeline cancelled', 'cancelled');
              let result: C.Result<C.Json>;
              if (step.kind === 'validate' || step.kind === 'assert') {
                result = read(step.value);
                if (!result.ok) return result;
                if (step.kind === 'validate') {
                  const checked = schemaFor(step.schema)!.validate(result.value);
                  if (!checked.ok) return fail('pipeline.validation', 'Validation step failed');
                  result = ok(checked.value);
                } else if (canonical(result.value) !== canonical(step.equals))
                  return fail('pipeline.assert', 'Assertion failed');
              } else if (step.kind === 'wait') {
                const binding = read(step.binding);
                if (!binding.ok) return binding;
                const responseSchema = schemaFor(step.response)!,
                  bindingDigest = await digest(binding.value),
                  spec = {
                    type: 'part/pipeline-wait',
                    responseSchema,
                    presentation: { prompt: step.prompt },
                    bindingDigest,
                  };
                const identity = await callIdentity(context.execution, step.id, {
                  type: spec.type,
                  responseSchema: { ...responseSchema.ref },
                  presentation: spec.presentation,
                  bindingDigest,
                });
                const ticket = await context.wait(identity, spec);
                if (!ticket.ok) return ticket;
                result = await context.response(ticket.value);
              } else if (step.kind === 'script') {
                const stdin = read(step.stdin);
                if (!stdin.ok) return stdin;
                const request = { ...step.request, stdin: stdin.value },
                  identity = await callIdentity(
                    context.execution,
                    step.id,
                    request as unknown as C.Json,
                  );
                const outcome = await context.script(identity, request);
                if (outcome.phase !== 'completed')
                  return fail(
                    'pipeline.script',
                    'Script step failed',
                    outcome.phase === 'cancelled' ? 'cancelled' : 'internal',
                    outcome.effect,
                  );
                if (outcome.result.captured?.kind !== 'inline')
                  return fail('pipeline.capture', 'Script step requires explicit JSON capture');
                result = ok(outcome.result.captured.value);
              } else if (step.kind === 'agent') {
                const value = read(step.input);
                if (!value.ok) return value;
                const profile = options.agents![step.profile]!;
                const identity = await callIdentity(context.execution, step.id, {
                  driver: profile.driver,
                  input: value.value,
                  compositionRevision: profile.composition.inspection.revision,
                });
                const outcome = await context.agent(identity, {
                  driver: profile.driver,
                  input: value.value,
                  composition: profile.composition,
                });
                result =
                  outcome.phase === 'completed' && isJson(outcome.result)
                    ? ok(outcome.result)
                    : fail('pipeline.agent', 'Agent step failed', 'internal', outcome.effect);
              } else if (step.kind === 'extension') {
                const value = read(step.input);
                if (!value.ok) return value;
                const handler = handlers.get(step.handler)!;
                if (!handler.input.validate(value.value).ok)
                  return fail('pipeline.handler-input', 'Handler input validation failed');
                const identity = await callIdentity(context.execution, step.id, value.value);
                const outcome = await managedAttempt<C.Json>(
                  options.boundary ?? createBoundary(),
                  {
                    operationId: invocation.scope.id,
                    attemptId: crypto.randomUUID(),
                    target: handler.id,
                    executor: 'part/pipeline-handler',
                    inputDigest: await digest({ input: value.value, config: step.config }),
                    scopeDigest: await digest({
                      principal: invocation.principal,
                      scope: { ...invocation.scope },
                    }),
                    compositionRevision: '1',
                    classification: handler.effects,
                  },
                  async () => {
                    const budget = reserve(invocation, 'maxExecutorAttempts');
                    if (!budget.ok)
                      return { kind: 'failed', error: budget.error, effect: 'not-attempted' };
                    const executed = await handler.execute(
                      value.value,
                      step.config,
                      identity,
                      context,
                    );
                    return executed.ok
                      ? {
                          kind: 'returned',
                          value: executed.value,
                          effect: handler.effects === 'read' ? 'not-applied' : 'applied',
                        }
                      : {
                          kind: 'failed',
                          error: executed.error,
                          effect:
                            executed.error.effect ??
                            (handler.effects === 'read' ? 'not-applied' : 'unknown'),
                        };
                  },
                  invocation,
                );
                record(outcome);
                result =
                  outcome.phase === 'completed'
                    ? ok(outcome.result)
                    : fail('pipeline.handler', 'Handler step failed', 'internal', outcome.effect);
              } else return fail('pipeline.kind', 'Unsupported step', 'unsupported');
              if (!result.ok) return result;
              results.set(step.id, structuredClone(result.value));
            }
            return read(definition.result);
          },
        });
      },
    }),
  );
}
