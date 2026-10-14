import type { Contracts as C, Hooks as H, Scripts as S } from './reference.js';
import { ok, fail, canonical, isJsonObject } from './contracts.js';
export function createScriptHooks(
  points: readonly H.Point<unknown, unknown>[],
  scripts: S.Service,
): C.Result<
  H.Service & {
    fire(
      id: string,
      input: unknown,
      context: C.InvocationContext,
    ): Promise<C.Result<readonly unknown[]>>;
    closeOwner(owner: C.EntityRef): void;
  }
> {
  const registry = new Map(points.map((p) => [p.id, p]));
  if (registry.size !== points.length) return fail('hook.duplicate', 'Duplicate hook point');
  const bindings = new Map<
      string,
      { binding: H.Binding; principal: C.InvocationContext['principal']; consumed: boolean }
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
      if (binding.match)
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
          canonical(entry.binding.activationOwner as unknown as C.Json) ===
          canonical(owner as unknown as C.Json)
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
        const key = `${binding.id}/${context.correlationId}`,
          current = depth.get(key) ?? 0;
        if (current >= (binding.reentrancy === 'deny' ? 1 : 8))
          return fail('hook.reentrancy', 'Hook recursion limit exceeded', 'conflict');
        if (binding.once) entry.consumed = true;
        depth.set(key, current + 1);
        try {
          const script = await scripts.execute(
            {
              ...binding.script,
              stdin: {
                point: { id: point.id, version: point.version },
                input: checked.value as C.Json,
              },
            },
            context,
          );
          if (!script.ok) {
            if (binding.failure === 'report-and-continue') continue;
            return script;
          }
          const outcome = await script.value.done;
          if (
            outcome.phase !== 'completed' ||
            outcome.result.exitCode !== 0 ||
            outcome.result.captured?.kind !== 'inline'
          ) {
            if (binding.failure === 'report-and-continue') continue;
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
          output.push(result.value);
        } finally {
          if (current) depth.set(key, current);
          else depth.delete(key);
        }
      }
      return ok(output);
    },
  });
}
