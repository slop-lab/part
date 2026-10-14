import type {
  Contracts as C,
  PipelineV1 as P,
  Workflows as W,
  Composition as L,
  Runtime as R,
  Skills as K,
} from './reference.js';
import { ok, fail, digest, canonical, isJson, isJsonObject } from './contracts.js';
import { createMemoryWorkflowEngine, callIdentity, scopeStepContext } from './workflow-memory.js';
import { createBoundary, managedAttempt, createOperations } from './runtime.js';
import { isScriptRequest } from './scripts.js';
import { reserve } from './model.js';
import type { OperationContext } from './runtime.js';
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
  capabilities?: C.CapabilitySet;
  skills?: {
    service: K.Service;
    bind(input: C.Json, activations: readonly K.Activation[]): C.Result<C.Json>;
  };
}): C.Result<W.Engine> {
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
          : ok([] as readonly K.Descriptor[]);
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
        if ((await digest(definition as unknown as C.Json)) !== request.definition.digest)
          return fail('pipeline.digest', 'Pipeline digest mismatch', 'conflict');
        const input = schemaFor(definition.input),
          output = schemaFor(definition.output);
        if (!input || !output)
          return fail('pipeline.schema', 'Input/output schema not installed', 'unsupported');
        type Block = { sorted: P.Step[]; steps: Map<string, P.Step> };
        const blocks = new WeakMap<object, Block>();
        let total = 0;
        function compileBlock(source: readonly P.Step[], depth = 0): C.Result<Block> {
          if (
            !Array.isArray(source) ||
            !source.length ||
            depth > 32 ||
            (total += source.length) > 10000
          )
            return fail('pipeline.block', 'Invalid or oversized lexical block');
          const steps = new Map<string, P.Step>(),
            ancestors = new Map<string, Set<string>>();
          for (const step of source) {
            if (
              !objectValid(step) ||
              typeof step.id !== 'string' ||
              !step.id ||
              !Array.isArray(step.after) ||
              step.after.some((id: unknown) => typeof id !== 'string') ||
              steps.has(step.id)
            )
              return fail('pipeline.step', 'Invalid or duplicate pipeline step');
            if (
              step.timeoutMs !== undefined &&
              (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1)
            )
              return fail('pipeline.timeout', 'Invalid step timeout');
            const allowed: Record<string, string[]> = {
              validate: ['value', 'schema'],
              assert: ['value', 'equals'],
              wait: ['response', 'binding', 'prompt'],
              script: ['request', 'stdin'],
              agent: ['profile', 'input', 'skills'],
              extension: ['handler', 'handlerVersion', 'input', 'config'],
              branch: ['value', 'cases', 'otherwise'],
              repeat: ['maxIterations', 'body', 'until'],
              parallel: ['maxConcurrency', 'onError', 'branches'],
            };
            if (!allowed[step.kind])
              return fail(
                'pipeline.kind',
                `Unsupported pipeline step: ${step.kind}`,
                'unsupported',
              );
            if (
              Object.keys(step).some(
                (key) =>
                  !['id', 'kind', 'after', 'timeoutMs', ...allowed[step.kind]!].includes(key),
              )
            )
              return fail('pipeline.field', `Unsupported step field in ${step.id}`, 'unsupported');
            if (
              (step.kind === 'validate' && (!valueValid(step.value) || !schemaFor(step.schema))) ||
              (step.kind === 'assert' &&
                (!valueValid(step.value) || !Object.hasOwn(step, 'equals'))) ||
              (step.kind === 'wait' &&
                (!valueValid(step.binding) ||
                  !schemaFor(step.response) ||
                  typeof step.prompt !== 'string' ||
                  !options.services.waits)) ||
              (step.kind === 'script' &&
                (!valueValid(step.stdin) ||
                  !isScriptRequest(step.request) ||
                  !options.services.scripts)) ||
              (step.kind === 'agent' &&
                (!valueValid(step.input) ||
                  !options.agents ||
                  !Object.hasOwn(options.agents, step.profile) ||
                  !options.services.runs)) ||
              (step.kind === 'extension' && !valueValid(step.input))
            )
              return fail(
                'pipeline.requirement',
                `Missing schema, value, or service in ${step.id}`,
                'unsupported',
              );
            if (step.kind === 'agent' && step.skills) {
              if (
                !options.skills ||
                !Array.isArray(step.skills) ||
                step.skills.some(
                  (skill: { id: string; digest: string }) =>
                    !isJsonObject(skill) ||
                    Object.keys(skill).some((key) => !['id', 'digest'].includes(key)) ||
                    !installedSkills.some(
                      (installed) =>
                        installed.id === skill.id && installed.package.digest === skill.digest,
                    ),
                )
              )
                return fail(
                  'pipeline.skill',
                  'Pinned skill or binding adapter unavailable',
                  'unsupported',
                );
            }
            if (step.kind === 'extension') {
              const handler = handlers.get(step.handler);
              if (
                !handler ||
                handler.version !== step.handlerVersion ||
                handler.requires.some(
                  (id) =>
                    !options.capabilities?.entries.some(
                      (c) => c.id === id && c.status === 'supported',
                    ),
                )
              )
                return fail(
                  'pipeline.handler',
                  'Handler/version/capability not installed',
                  'unsupported',
                );
              if (!handler.config.validate(step.config).ok)
                return fail('pipeline.handler-config', 'Handler config validation failed');
            }
            let nested: readonly (readonly P.Step[])[] = [];
            if (step.kind === 'branch') {
              if (
                !valueValid(step.value) ||
                !Array.isArray(step.cases) ||
                !step.cases.length ||
                step.cases.some(
                  (c: { equals: C.Json; run: readonly P.Step[] }) =>
                    !isJsonObject(c) ||
                    Object.keys(c).some((k) => !['equals', 'run'].includes(k)) ||
                    !Object.hasOwn(c, 'equals'),
                ) ||
                new Set(
                  step.cases.map((c: { equals: C.Json; run: readonly P.Step[] }) =>
                    canonical(c.equals),
                  ),
                ).size !== step.cases.length
              )
                return fail('pipeline.branch', 'Invalid or duplicate branch cases');
              nested = [
                ...step.cases.map((c: { equals: C.Json; run: readonly P.Step[] }) => c.run),
                ...(step.otherwise ? [step.otherwise] : []),
              ];
            } else if (step.kind === 'repeat') {
              if (
                !Number.isSafeInteger(step.maxIterations) ||
                step.maxIterations < 1 ||
                step.maxIterations > 10000 ||
                !isJsonObject(step.until) ||
                !valueValid(step.until.value) ||
                !Object.hasOwn(step.until, 'equals') ||
                Object.keys(step.until).some((k) => !['value', 'equals'].includes(k))
              )
                return fail('pipeline.repeat', 'Invalid bounded repeat');
              nested = [step.body];
            } else if (step.kind === 'parallel') {
              if (
                !Number.isSafeInteger(step.maxConcurrency) ||
                step.maxConcurrency < 1 ||
                step.maxConcurrency > 64 ||
                !['cancel-and-join', 'collect'].includes(step.onError) ||
                !Array.isArray(step.branches) ||
                !step.branches.length
              )
                return fail('pipeline.parallel', 'Invalid bounded parallel block');
              nested = step.branches;
            }
            for (const source of nested) {
              const compiled = compileBlock(source, depth + 1);
              if (!compiled.ok) return compiled;
              blocks.set(source, compiled.value);
            }
            if (
              step.kind === 'repeat' &&
              'step' in step.until.value &&
              !blocks.get(step.body)!.steps.has(step.until.value.step)
            )
              return fail(
                'pipeline.reference',
                'Repeat condition references a different lexical block',
              );
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
              step.kind === 'validate' || step.kind === 'assert' || step.kind === 'branch'
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
          return ok({ sorted, steps });
        }
        const compiled = compileBlock(definition.steps);
        if (!compiled.ok) return compiled;
        if ('step' in definition.result && !compiled.value.steps.has(definition.result.step))
          return fail('pipeline.result', 'Unknown result step');
        const mainBlock = compiled.value,
          finalValue = definition.result;
        return ok({
          input,
          output,
          async execute(input, context, invocation, record) {
            async function runBlock(
              block: Block,
              context: W.StepContext,
              invocation: OperationContext,
              path: readonly (string | number)[],
              selection?: P.Value,
            ): Promise<C.Result<C.Json>> {
              const results = new Map<string, C.Json>();
              const read = (value: P.Value): C.Result<C.Json> =>
                'literal' in value
                  ? ok(structuredClone(value.literal))
                  : 'input' in value
                    ? pointer(input, value.input)
                    : results.has(value.step)
                      ? pointer(results.get(value.step)!, value.pointer)
                      : fail('pipeline.value', 'Step result is unavailable');
              const identify = (execution: W.ExecutionRef, stepKey: string, value: C.Json) =>
                callIdentity(execution, stepKey, value, path);
              async function runStep(
                step: P.Step,
                context: W.StepContext,
                invocation: OperationContext,
              ): Promise<C.Result<C.Json>> {
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
                  const identity = await identify(context.execution, step.id, {
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
                    identity = await identify(
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
                  const activations: K.Activation[] = [];
                  let boundInput = value.value;
                  try {
                    for (const skill of step.skills ?? []) {
                      const activated = await options.skills!.service.activate(
                        {
                          skillId: skill.id,
                          packageDigest: skill.digest,
                          owner: {
                            owner: 'part/workflow-pipeline-v1',
                            kind: 'step',
                            id: invocation.scope.id,
                          },
                          purpose: 'Managed pipeline agent input',
                          scope: 'invocation',
                        },
                        invocation,
                      );
                      if (!activated.ok) return activated;
                      activations.push(activated.value);
                    }
                    if (activations.length) {
                      const bound = options.skills!.bind(boundInput, activations);
                      if (!bound.ok) return bound;
                      boundInput = bound.value;
                    }
                    const profile = options.agents![step.profile]!;
                    const identity = await identify(context.execution, step.id, {
                      driver: profile.driver,
                      input: boundInput,
                      compositionRevision: profile.composition.inspection.revision,
                    });
                    const outcome = await context.agent(identity, {
                      driver: profile.driver,
                      input: boundInput,
                      composition: profile.composition,
                    });
                    result =
                      outcome.phase === 'completed' && isJson(outcome.result)
                        ? ok(outcome.result)
                        : fail('pipeline.agent', 'Agent step failed', 'internal', outcome.effect);
                  } finally {
                    for (const activation of activations.reverse())
                      await options.skills!.service.deactivate(activation.id, {
                        ...invocation,
                        signal: new AbortController().signal,
                      });
                  }
                } else if (step.kind === 'extension') {
                  const value = read(step.input);
                  if (!value.ok) return value;
                  const handler = handlers.get(step.handler)!;
                  if (!handler.input.validate(value.value).ok)
                    return fail('pipeline.handler-input', 'Handler input validation failed');
                  const identity = await identify(context.execution, step.id, value.value);
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
                } else if (step.kind === 'branch') {
                  const value = read(step.value);
                  if (!value.ok) return value;
                  const index = step.cases.findIndex(
                    (c) => canonical(c.equals) === canonical(value.value),
                  );
                  const selected = index >= 0 ? step.cases[index]!.run : step.otherwise;
                  if (!selected) return fail('pipeline.branch', 'No branch case matched');
                  result = await runBlock(blocks.get(selected)!, context, invocation, [
                    ...path,
                    step.id,
                    index >= 0 ? index : 'otherwise',
                  ]);
                } else if (step.kind === 'repeat') {
                  for (let iteration = 0; iteration < step.maxIterations; iteration++) {
                    const checked = await runBlock(
                      blocks.get(step.body)!,
                      context,
                      invocation,
                      [...path, step.id, iteration],
                      step.until.value,
                    );
                    if (!checked.ok) return checked;
                    const values = checked.value as { condition: C.Json; result: C.Json };
                    if (canonical(values.condition) === canonical(step.until.equals))
                      return ok(values.result);
                  }
                  return fail('pipeline.repeat', 'Repeat exceeded maxIterations');
                } else if (step.kind === 'parallel') {
                  const outputs: C.Result<C.Json>[] = new Array(step.branches.length);
                  const cancellation = new AbortController();
                  let cursor = 0,
                    failed = false;
                  const workers = Array.from(
                    { length: Math.min(step.maxConcurrency, step.branches.length) },
                    async () => {
                      while (
                        cursor < step.branches.length &&
                        !(failed && step.onError === 'cancel-and-join')
                      ) {
                        const index = cursor++,
                          branch = step.branches[index]!;
                        const child = await operations.begin<C.Json>(
                          {
                            kind: 'part/pipeline-branch',
                            childPolicy: 'attached',
                            retryOwner: 'part/workflow-pipeline-v1',
                          },
                          async (c) => {
                            const value = await runBlock(
                              blocks.get(branch)!,
                              scopeStepContext(context, c),
                              c,
                              [...path, step.id, index],
                            );
                            return value.ok
                              ? {
                                  phase: 'completed',
                                  result: value.value,
                                  effect: 'not-applicable',
                                  commit: [],
                                  unsettledChildren: [],
                                }
                              : {
                                  phase: 'failed',
                                  error: value.error,
                                  effect: value.error.effect ?? 'not-attempted',
                                  commit: [],
                                  unsettledChildren: [],
                                };
                          },
                          {
                            ...invocation,
                            signal: AbortSignal.any([invocation.signal, cancellation.signal]),
                          },
                        );
                        if (!child.ok) outputs[index] = child;
                        else {
                          const outcome = await child.value.done;
                          if (outcome.phase === 'abandoned') record(outcome);
                          outputs[index] =
                            outcome.phase === 'completed'
                              ? ok(outcome.result)
                              : fail(
                                  'pipeline.parallel-child',
                                  'Parallel branch failed',
                                  outcome.phase === 'cancelled' ? 'cancelled' : 'internal',
                                  outcome.effect,
                                );
                        }
                        if (!outputs[index]!.ok) {
                          failed = true;
                          if (step.onError === 'cancel-and-join')
                            cancellation.abort('parallel-branch-failed');
                        }
                      }
                    },
                  );
                  await Promise.all(workers);
                  if (failed)
                    return fail(
                      'pipeline.parallel',
                      'One or more required parallel branches failed',
                    );
                  result = ok(outputs.map((value) => (value as { ok: true; value: C.Json }).value));
                } else return fail('pipeline.kind', 'Unsupported step', 'unsupported');
                return result;
              }
              for (const step of block.sorted) {
                if (context.signal.aborted)
                  return fail('pipeline.cancelled', 'Pipeline cancelled', 'cancelled');
                const deadlines = [
                  invocation.deadline ? Date.parse(invocation.deadline) : Infinity,
                  step.timeoutMs ? Date.now() + step.timeoutMs : Infinity,
                ];
                const deadline = Math.min(...deadlines);
                const child = await operations.begin<C.Json>(
                  {
                    kind: 'part/pipeline-step',
                    childPolicy: 'attached',
                    retryOwner: 'part/workflow-pipeline-v1',
                  },
                  async (c) => {
                    const result = await runStep(step, scopeStepContext(context, c), c);
                    return result.ok
                      ? {
                          phase: 'completed',
                          result: result.value,
                          effect: 'not-applicable',
                          commit: [],
                          unsettledChildren: [],
                        }
                      : {
                          phase: 'failed',
                          error: result.error,
                          effect: result.error.effect ?? 'not-attempted',
                          commit: [],
                          unsettledChildren: [],
                        };
                  },
                  {
                    ...invocation,
                    ...(Number.isFinite(deadline)
                      ? { deadline: new Date(deadline).toISOString() }
                      : {}),
                  },
                );
                if (!child.ok) return child;
                const outcome = await child.value.done;
                if (outcome.phase === 'abandoned') record(outcome);
                if (outcome.phase !== 'completed')
                  return fail(
                    'pipeline.step-failed',
                    'Required pipeline step failed',
                    outcome.phase === 'cancelled' ? 'cancelled' : 'internal',
                    outcome.effect,
                  );
                results.set(step.id, structuredClone(outcome.result));
              }
              const last = results.get(block.sorted.at(-1)!.id)!;
              if (selection) {
                const condition = read(selection);
                return condition.ok ? ok({ condition: condition.value, result: last }) : condition;
              }
              return block === mainBlock ? read(finalValue) : ok(last);
            }
            return runBlock(mainBlock, context, invocation, []);
          },
        });
      },
    }),
  );
}
