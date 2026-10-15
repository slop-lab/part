import { canonical, fail, isJsonObject, ok } from '@part/core/contracts';
import type { Contracts, Hooks, Runtime, Scripts } from '@part/core/reference';
export function createScriptHooks(
  points: readonly Hooks.Point<unknown, unknown>[],
  scripts: Scripts.Service,
  options: {
    match?: (
      matcher: Contracts.Json,
      input: unknown,
      context: Contracts.InvocationContext,
    ) => Contracts.Result<boolean>;
    report?: (
      binding: Hooks.Binding,
      error: Contracts.Failure,
      context: Contracts.InvocationContext,
    ) => void;
  } = {},
): Contracts.Result<
  Hooks.Service & {
    fire(
      id: string,
      input: unknown,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<readonly unknown[]>>;
    closeOwner(owner: Contracts.EntityRef): void;
  }
> {
  const registry = new Map(points.map((p) => [p.id, p]));
  if (registry.size !== points.length) return fail('hook.duplicate', 'Duplicate hook point');
  const bindings = new Map<
      string,
      {
        binding: Hooks.Binding;
        principal: Contracts.InvocationContext['principal'];
        consumed: boolean;
      }
    >(),
    depth = new Map<string, number>();
  return ok({
    async bind(binding, context) {
      const point = registry.get(binding.pointId);
      if (!point || point.version !== binding.pointVersion)
        return fail('hook.point', 'Hook point/version not installed', 'unsupported');
      if (bindings.has(binding.id))
        return fail('hook.duplicate', 'Duplicate hook binding', 'conflict');
      if (
        point.phase === 'before-effect' &&
        (!point.awaited || binding.failure === 'report-and-continue')
      )
        return fail('hook.failure-policy', 'Before-effect checks must await and fail closed');
      if (binding.script.capture.kind !== 'stdout-json')
        return fail('hook.capture', 'Hook decisions require explicit stdout-json capture');
      if (binding.match && !options.match)
        return fail('hook.matcher', 'Matchers are not installed in this subset', 'unsupported');
      bindings.set(binding.id, {
        binding: structuredClone(binding),
        principal: { ...context.principal },
        consumed: false,
      });
      return ok({ owner: 'part/hooks', kind: 'binding', id: binding.id });
    },
    async unbind(ref, context) {
      const existing = bindings.get(ref.id);
      if (!existing) return fail('hook.binding', 'Hook binding not found');
      if (canonical(existing.principal) !== canonical(context.principal))
        return fail('hook.permission', 'Binding access denied', 'permission');
      bindings.delete(ref.id);
      return ok(undefined);
    },
    closeOwner(owner) {
      for (const [id, entry] of bindings)
        if (
          canonical(entry.binding.activationOwner as unknown as Contracts.Json) ===
          canonical(owner as unknown as Contracts.Json)
        )
          bindings.delete(id);
    },
    async fire(id, input, context) {
      const point = registry.get(id);
      if (!point) return fail('hook.point', 'Hook point not installed', 'unsupported');
      const checked = point.input.validate(input);
      if (!checked.ok) return fail('hook.input', 'Hook input validation failed');
      const output: unknown[] = [];
      for (const entry of bindings.values()) {
        const binding = entry.binding;
        if (
          binding.pointId !== id ||
          canonical(entry.principal) !== canonical(context.principal) ||
          entry.consumed
        )
          continue;
        if (binding.scope !== 'host' && binding.activationOwner.id !== context.scope.id) continue;
        if (binding.match) {
          const matched = options.match!(binding.match, checked.value, context);
          if (!matched.ok) return matched;
          if (!matched.value) continue;
        }
        const key = `${binding.id}/${context.correlationId}`,
          current = depth.get(key) ?? 0;
        if (current >= (binding.reentrancy === 'deny' ? 1 : 8))
          return fail('hook.reentrancy', 'Hook recursion limit exceeded', 'conflict');
        if (binding.once) entry.consumed = true;
        depth.set(key, current + 1);
        try {
          const executed = await (async (): Promise<Contracts.Result<unknown>> => {
            const script = await scripts.execute(
              {
                ...binding.script,
                stdin: {
                  point: { id: point.id, version: point.version },
                  input: checked.value as Contracts.Json,
                },
              },
              context,
            );
            if (!script.ok) {
              return script;
            }
            const outcome = await script.value.done;
            if (
              outcome.phase !== 'completed' ||
              outcome.result.exitCode !== 0 ||
              outcome.result.captured?.kind !== 'inline'
            ) {
              return fail(
                'hook.script',
                'Required hook did not return a successful explicit result',
                'internal',
                outcome.effect,
              );
            }
            const result = point.output.validate(outcome.result.captured.value);
            if (!result.ok) return fail('hook.output', 'Hook output validation failed');
            if (
              !isJsonObject(result.value) ||
              typeof result.value.kind !== 'string' ||
              !point.allowedDecisions.includes(result.value.kind)
            )
              return fail('hook.decision', 'Hook decision is not allowed');
            return ok(result.value);
          })().catch(() => fail('hook.exception', 'Hook execution failed', 'internal', 'unknown'));
          if (!executed.ok) {
            try {
              options.report?.(binding, executed.error, context);
            } catch {}
            (
              context as Contracts.InvocationContext & { progress?: Runtime.ProgressSink }
            ).progress?.publish('part.hook/failure', {
              bindingId: binding.id,
              code: executed.error.code,
              policy: binding.failure,
            });
            if (binding.failure === 'report-and-continue') continue;
            return executed;
          }
          output.push(executed.value);
        } finally {
          if (current) depth.set(key, current);
          else depth.delete(key);
        }
      }
      return ok(output);
    },
  });
}
