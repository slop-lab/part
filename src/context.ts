import type { Contracts, Context, Model, Composition } from './reference.js';
import { ok, fail, digest, freeze, isJson } from './contracts.js';

export const lowerersPoint: Composition.ExtensionPoint<Context.Lowerer<unknown>> = {
  id: 'part.context/lowerers',
  owner: 'part/context',
  contractVersion: 1,
  kind: 'registry',
  scope: 'runtime',
};
export const lowerersKey: Contracts.ServiceKey<ReadonlyMap<string, Context.Lowerer<unknown>>> = {
  id: lowerersPoint.id,
  contractVersion: lowerersPoint.contractVersion,
  scope: lowerersPoint.scope,
};
export const transformsPoint: Composition.ExtensionPoint<Context.SetTransform> = {
  id: 'part.context/transforms',
  owner: 'part/context',
  contractVersion: 1,
  kind: 'pipeline',
  scope: 'runtime',
};
export const transformsKey: Contracts.ServiceKey<readonly Context.SetTransform[]> = {
  id: transformsPoint.id,
  contractVersion: transformsPoint.contractVersion,
  scope: transformsPoint.scope,
};
export const provenance: Contracts.Provenance = Object.freeze({
  component: 'part/context',
  componentVersion: '0.1.0-alpha.2',
  origin: 'module',
});
const sourceKey = (source: Context.SourceRef) => JSON.stringify(source);
export async function semanticItem(
  type: string,
  payload: Contracts.Json,
  id: string = crypto.randomUUID(),
  schemaVersion = 1,
): Promise<Context.SemanticItem<Contracts.Json>> {
  const copy = structuredClone(payload),
    hash = await digest(copy);
  return freeze({
    id,
    type,
    schemaVersion,
    payload: copy,
    source: { kind: 'inline', id, digest: hash },
    provenance,
  });
}
export async function messageItem(
  role: Context.Fragment['role'],
  content: readonly Model.ContentPart[],
  relation?: Context.Fragment['toolRelation'],
): Promise<Context.SemanticItem<Contracts.Json>> {
  return semanticItem('part/message', {
    role: role ?? 'user',
    content: content as unknown as Contracts.Json,
    ...(relation ? { relation: { ...relation } } : {}),
  });
}
export const messageLowerer: Context.Lowerer<unknown> = {
  id: 'part/message-lowerer',
  accepts: { id: 'part/message', version: 1 },
  lower(item) {
    const payload = item.payload as {
      role?: Context.Fragment['role'];
      content?: Model.ContentPart[];
      relation?: Context.Fragment['toolRelation'];
    } | null;
    if (
      !payload ||
      !isJson(payload) ||
      !['system', 'developer', 'user', 'assistant', 'tool'].includes(payload.role ?? '') ||
      !Array.isArray(payload.content)
    )
      return fail('context.message', 'Invalid message item');
    for (const part of payload.content) {
      if (
        !part ||
        (part.kind === 'text'
          ? typeof part.text !== 'string'
          : part.kind === 'json'
            ? !isJson(part.value)
            : part.kind === 'native'
              ? !part.native || !isJson(part.native.payload)
              : part.kind !== 'media')
      )
        return fail('context.content', 'Invalid content part');
    }
    return ok({
      kind: 'include',
      fragments: [
        {
          id: item.id,
          kind: payload.relation
            ? payload.role === 'tool'
              ? 'tool-result'
              : 'tool-call'
            : 'message',
          role: payload.role,
          content: payload.content,
          ...(payload.relation ? { toolRelation: payload.relation } : {}),
          sources: [item.source],
          provenance: item.provenance,
        },
      ],
    });
  },
};
export const defaultPlanner: Context.Planner = {
  async plan(request) {
    return ok({
      id: crypto.randomUUID(),
      selections: request.sources.map((source) => ({
        source,
        required: true,
        reason: 'explicit input',
      })),
      policyRevision: 'part/explicit-v1',
    });
  },
};
export const defaultAssembler: Context.Assembler = {
  assemble(fragments) {
    const ids = new Set<string>(),
      calls = new Map<string, string>(),
      results = new Set<string>();
    for (const fragment of fragments) {
      if (ids.has(fragment.id) || !fragment.sources.length)
        return fail('context.fragment', 'Duplicate fragment ID or missing source');
      ids.add(fragment.id);
      if (fragment.kind === 'tool-call') {
        const relation = fragment.toolRelation;
        if (!relation || calls.has(relation.callId))
          return fail('context.tool-call', 'Invalid or duplicate tool call');
        calls.set(relation.callId, relation.toolId);
      }
      if (fragment.kind === 'tool-result') {
        const relation = fragment.toolRelation;
        if (
          !relation ||
          calls.get(relation.callId) !== relation.toolId ||
          results.has(relation.callId)
        )
          return fail('context.tool-result', 'Unmatched or duplicate tool result');
        results.add(relation.callId);
      }
    }
    return ok({
      fragments: [...fragments],
      sourceMap: fragments.map((f) => ({ fragmentId: f.id, sources: f.sources })),
    });
  },
};
export function createContextCompiler(
  options: {
    planner?: Context.Planner;
    resolver?: Context.Resolver;
    lowerers?: readonly Context.Lowerer<unknown>[];
    transforms?: readonly Context.SetTransform[];
    assembler?: Context.Assembler;
    compositionRevision?: string;
  } = {},
): Contracts.Result<Context.Compiler> {
  const lowerers = new Map<string, Context.Lowerer<unknown>>();
  for (const lowerer of options.lowerers ?? [messageLowerer]) {
    const key = `${lowerer.accepts.id}@${lowerer.accepts.version}`;
    if (lowerers.has(key)) return fail('context.duplicate-lowerer', key, 'conflict');
    lowerers.set(key, lowerer);
  }
  const planner = options.planner ?? defaultPlanner,
    transforms = [...(options.transforms ?? [])],
    assembler = options.assembler ?? defaultAssembler;
  return ok({
    async compile(request, context) {
      if (context.signal.aborted)
        return fail('context.cancelled', 'Compilation cancelled', 'cancelled');
      const planned = await planner.plan(request, context);
      if (!planned.ok) return planned;
      let fragments: Context.Fragment[] = [];
      const sourceVersions: Context.SourceVersion[] = [],
        decisions: Context.CompiledContext['decisions'][number][] = [],
        required = new Set<string>();
      for (const selection of planned.value.selections) {
        let items: readonly Context.SemanticItem[];
        if (selection.source.kind === 'inline') {
          const matches = request.input.filter(
            (item) => sourceKey(item.source) === sourceKey(selection.source),
          );
          if (!matches.length) return fail('context.source', 'Inline source not found');
          for (const item of matches)
            if (!isJson(item.payload) || (await digest(item.payload)) !== selection.source.digest)
              return fail('context.digest', 'Inline content digest mismatch', 'conflict');
          items = matches;
          sourceVersions.push({
            source: selection.source,
            observed: selection.source.digest,
            fidelity: 'content-addressed',
          });
        } else {
          if (!options.resolver)
            return fail(
              'context.resolver',
              'External source resolver is not installed',
              'unsupported',
            );
          const resolved = await options.resolver.resolve(selection, context);
          if (!resolved.ok) return resolved;
          items = resolved.value.items;
          sourceVersions.push(...resolved.value.versions);
        }
        if (!items.length && selection.required)
          return fail('context.required', 'Required source returned no items');
        for (const item of items) {
          const lowerer = lowerers.get(`${item.type}@${item.schemaVersion}`);
          if (!lowerer) {
            if (selection.required)
              return fail(
                'context.lowerer',
                `Required lowerer missing: ${item.type}@${item.schemaVersion}`,
                'unsupported',
              );
            decisions.push({
              source: item.source,
              disposition: 'omit',
              reason: 'Unsupported optional type',
              component: 'part/context',
            });
            continue;
          }
          const lowered = lowerer.lower(freeze(structuredClone(item)));
          if (!lowered.ok) return lowered;
          if (lowered.value.kind === 'omit') {
            if (selection.required)
              return fail('context.required', `Required item omitted: ${lowered.value.reason}`);
            decisions.push({
              source: item.source,
              disposition: 'omit',
              reason: lowered.value.reason,
              component: lowerer.id,
            });
            continue;
          }
          if (!lowered.value.fragments.length && selection.required)
            return fail('context.required', 'Required item lowered to no fragments');
          for (const fragment of lowered.value.fragments) {
            if (!fragment.sources.some((source) => sourceKey(source) === sourceKey(item.source)))
              return fail('context.provenance', 'Lowerer dropped source provenance');
            fragments.push(structuredClone(fragment));
          }
          if (selection.required) required.add(sourceKey(item.source));
          decisions.push({
            source: item.source,
            disposition: 'include',
            reason: selection.reason,
            component: lowerer.id,
          });
        }
      }
      for (const transform of transforms) {
        const transformed = await transform.transform(freeze(fragments), context);
        if (!transformed.ok) return transformed;
        fragments = structuredClone([...transformed.value]);
      }
      for (const source of required)
        if (!fragments.some((fragment) => fragment.sources.some((s) => sourceKey(s) === source)))
          return fail('context.required', 'Transform dropped required source');
      const assembled = assembler.assemble(fragments);
      if (!assembled.ok) return assembled;
      if (context.signal.aborted)
        return fail('context.cancelled', 'Compilation cancelled', 'cancelled');
      const value = {
        ...assembled.value,
        id: crypto.randomUUID(),
        compositionRevision: options.compositionRevision ?? 'memory',
        toolsDigest: request.toolsDigest,
        modelCapabilitiesRevision: request.modelCapabilities.revision,
        sourceVersions,
        decisions,
        consistency: 'per-source' as const,
        losses: [],
      };
      return ok(freeze({ ...value, digest: await digest(value as unknown as Contracts.Json) }));
    },
  });
}
