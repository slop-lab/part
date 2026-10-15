import { isScriptRequest } from '../../execution/requests.js';
import { canonical, fail, isJsonObject, ok } from '../../foundation/contracts.js';
import type { Contracts, PipelineV1, Skills } from '../../reference/index.js';
import type { Handler } from './handlers.js';
import type { Block, PipelineOptions } from './types.js';
import { objectValid, valueValid } from './values.js';
export function createBlockCompiler(
  options: PipelineOptions,
  handlers: ReadonlyMap<string, Handler>,
  schemaFor: (ref: Contracts.SchemaRef) => Contracts.Schema<Contracts.Json> | undefined,
  installedSkills: readonly Skills.Descriptor[],
) {
  const blocks = new WeakMap<object, Block>();
  let total = 0;
  function compileBlock(source: readonly PipelineV1.Step[], depth = 0): Contracts.Result<Block> {
    if (!Array.isArray(source) || !source.length || depth > 32 || (total += source.length) > 10000)
      return fail('pipeline.block', 'Invalid or oversized lexical block');
    const steps = new Map<string, PipelineV1.Step>(),
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
        return fail('pipeline.kind', `Unsupported pipeline step: ${step.kind}`, 'unsupported');
      if (
        Object.keys(step).some(
          (key) => !['id', 'kind', 'after', 'timeoutMs', ...allowed[step.kind]!].includes(key),
        )
      )
        return fail('pipeline.field', `Unsupported step field in ${step.id}`, 'unsupported');
      if (
        (step.kind === 'validate' && (!valueValid(step.value) || !schemaFor(step.schema))) ||
        (step.kind === 'assert' && (!valueValid(step.value) || !Object.hasOwn(step, 'equals'))) ||
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
              !options.capabilities?.entries.some((c) => c.id === id && c.status === 'supported'),
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
      let nested: readonly (readonly PipelineV1.Step[])[] = [];
      if (step.kind === 'branch') {
        if (
          !valueValid(step.value) ||
          !Array.isArray(step.cases) ||
          !step.cases.length ||
          step.cases.some(
            (c: { equals: Contracts.Json; run: readonly PipelineV1.Step[] }) =>
              !isJsonObject(c) ||
              Object.keys(c).some((k) => !['equals', 'run'].includes(k)) ||
              !Object.hasOwn(c, 'equals'),
          ) ||
          new Set(
            step.cases.map((c: { equals: Contracts.Json; run: readonly PipelineV1.Step[] }) =>
              canonical(c.equals),
            ),
          ).size !== step.cases.length
        )
          return fail('pipeline.branch', 'Invalid or duplicate branch cases');
        nested = [
          ...step.cases.map(
            (c: { equals: Contracts.Json; run: readonly PipelineV1.Step[] }) => c.run,
          ),
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
        return fail('pipeline.reference', 'Repeat condition references a different lexical block');
      steps.set(step.id, step);
    }
    const sorted: PipelineV1.Step[] = [],
      remaining = new Set(steps.keys());
    while (remaining.size) {
      for (const id of remaining)
        for (const dependency of steps.get(id)!.after)
          if (!steps.has(dependency)) return fail('pipeline.dependency', 'Unknown step dependency');
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

  return { blocks, compileBlock };
}
