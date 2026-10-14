import { sha256 } from './hash.js';
import type { Composition as P, Contracts as C } from './reference.js';
import { ok, fail, emptyCleanup, localContext, freeze, isJson, canonical } from './contracts.js';

type Point = P.ExtensionPoint<unknown>;
type Binding = P.Contribution<unknown>;
interface Plan { components: readonly P.ComponentFactory[]; config: C.Json; points: Map<string, Point>; bindings: Map<string, Binding[]>; factories: Map<string, P.ServiceFactory<unknown>>; factoryOrder: string[] }
const plans = new WeakMap<object, Plan>();
const same = (a: Point, b: Point) => a.id === b.id && a.owner === b.owner && a.contractVersion === b.contractVersion && a.kind === b.kind && a.scope === b.scope;
function order(ids: string[], edges: [string, string][]): C.Result<string[]> {
  const remaining = new Set(ids), result: string[] = [];
  for (const [a, b] of edges) if (!remaining.has(a) || !remaining.has(b)) return fail('composition.order-target', `Unknown ordering target ${a} -> ${b}`);
  while (remaining.size) {
    const next = [...remaining].sort().find(id => !edges.some(([a, b]) => b === id && remaining.has(a)));
    if (!next) return fail('composition.cycle', 'Dependency or ordering cycle');
    result.push(next); remaining.delete(next);
  }
  return ok(result);
}
export function createPlanner(): P.CompositionPlanner {
  return { resolve(spec) {
    const points = new Map<string, Point>(), bindings = new Map<string, Binding[]>(), factories = new Map<string, P.ServiceFactory<unknown>>();
    const errors: C.Failure[] = [];
    const record = (r: C.Result<void>) => { if (!r.ok) errors.push(r.error); return r; };
    const port: P.RegistrationPort = {
      declare(point) {
        const existing = points.get(point.id);
        if (existing && !same(existing, point as Point)) return record(fail('composition.point-conflict', point.id));
        points.set(point.id, Object.freeze({ ...point }) as Point); return ok(undefined);
      },
      contribute(contribution) {
        const point = points.get(contribution.point.id);
        if (!point || !same(point, contribution.point as Point)) return record(fail('composition.point-mismatch', contribution.point.id));
        const list = bindings.get(point.id) ?? [];
        if (list.some(item => item.id === contribution.id)) return record(fail('composition.duplicate', contribution.id));
        list.push({ ...contribution, point, before: [...(contribution.before ?? [])], after: [...(contribution.after ?? [])] } as Binding);
        bindings.set(point.id, list); return ok(undefined);
      },
      provide(point, factory) {
        const declared = points.get(point.id);
        if (!declared || !same(declared, point as Point) || point.kind !== 'service' || point.scope !== factory.scope) return record(fail('composition.service-scope', point.id));
        if (factories.has(point.id)) return record(fail('composition.duplicate-service', point.id));
        factories.set(point.id, { ...factory, dependencies: factory.dependencies.map(d => ({ ...d })) } as P.ServiceFactory<unknown>); return ok(undefined);
      },
      replace(replacement) {
        const point = points.get(replacement.point.id), list = bindings.get(replacement.point.id);
        const index = list?.findIndex(binding => binding.id === replacement.replaces) ?? -1;
        if (!point || !same(point, replacement.point as Point) || !same(point, replacement.with.point as Point) || index < 0) return record(fail('composition.replace-target', replacement.replaces));
        list!.splice(index, 1); return port.contribute(replacement.with);
      },
    };
    try {
      const ids = new Set<string>();
      for (const component of spec.components) {
        if (ids.has(component.descriptor.id)) return fail('composition.duplicate-component', component.descriptor.id);
        ids.add(component.descriptor.id);
        const r = component.register(port); if (!r.ok) return r;
      }
      for (const edit of spec.edits ?? []) { const r = edit(port); if (!r.ok) return r; }
    } catch { return fail('composition.register', 'Component registration failed', 'internal'); }
    if (errors.length) return { ok: false, error: errors[0]! };
    const capabilities = spec.components.flatMap(c => c.descriptor.provides);
    const componentEdges: [string, string][] = [];
    for (const component of spec.components) for (const req of component.descriptor.requires) {
      const providers = spec.components.filter(c => c.descriptor.provides.some(p => p.id === req.id && p.contractVersion === req.contractVersion && p.status === 'supported'));
      if (providers.length !== 1 && !(req.optional && providers.length === 0)) return fail('composition.requirement', `Unresolved or ambiguous requirement ${req.id}`);
      if (providers[0] && providers[0] !== component) componentEdges.push([providers[0].descriptor.id, component.descriptor.id]);
    }
    const componentOrder = order(spec.components.map(c => c.descriptor.id), componentEdges); if (!componentOrder.ok) return componentOrder;
    const factoryEdges: [string, string][] = [];
    for (const [id, factory] of factories) for (const dep of factory.dependencies) {
      const point = points.get(dep.id);
      if (!point || !factories.has(dep.id) || point.contractVersion !== dep.contractVersion || point.scope !== dep.scope || factory.scope !== dep.scope) return fail('composition.service-dependency', `Invalid dependency ${id} -> ${dep.id}`);
      factoryEdges.push([dep.id, id]);
    }
    const factoryOrder = order([...factories.keys()], factoryEdges); if (!factoryOrder.ok) return factoryOrder;
    for (const [id, list] of bindings) {
      const point = points.get(id)!;
      if (point.kind === 'service' && (list.length > 1 || factories.has(id))) return fail('composition.duplicate-service', id);
      if (point.kind === 'registry' && (list.some(b => !b.key) || new Set(list.map(b => b.key)).size !== list.length)) return fail('composition.duplicate-key', id);
      const sorted = order(list.map(b => b.id), list.flatMap(b => [...(b.before ?? []).map(target => [b.id, target] as [string, string]), ...(b.after ?? []).map(target => [target, b.id] as [string, string])]));
      if (!sorted.ok) return sorted;
      bindings.set(id, sorted.value.map(key => list.find(b => b.id === key)!));
    }
    const token = {}, revision = crypto.randomUUID();
    const components = componentOrder.value.map(id => spec.components.find(c => c.descriptor.id === id)!);
    let config: C.Json;
    try { if (!isJson(spec.config)) return fail('composition.config', 'Configuration must be lossless JSON'); config = freeze(structuredClone(spec.config)); } catch { return fail('composition.config', 'Configuration must be cloneable JSON'); }
    const inspection: P.ResolvedComposition = freeze({ id: crypto.randomUUID(), revision, digest: sha256(new TextEncoder().encode(canonical({ components: components.map(c => c.descriptor) as unknown as C.Json, config, bindings: [...bindings].map(([point, list]) => ({ point, contributions: list.map(b => ({ id: b.id, key: b.key ?? null })) })) }))),
      components: components.map(c => structuredClone(c.descriptor)), orderedBindings: [...bindings].map(([point, list]) => ({ point, contributions: list.map(b => b.id) })),
      capabilities: { revision, entries: structuredClone(capabilities) }, configProvenance: [{ key: '*', source: 'explicit', effective: config }], warnings: ['Composition digest covers descriptors, configuration and bindings; executable code is identified by component version.'] });
    plans.set(token, { components, config, points, bindings, factories, factoryOrder: factoryOrder.value });
    return ok({ inspection, localToken: token });
  } };
}
export function createScopeManager(): P.ScopeManager {
  return { async open(scope, composition) {
    const plan = typeof composition.localToken === 'object' && composition.localToken !== null ? plans.get(composition.localToken) : undefined;
    if (!plan) return fail('composition.handle', 'Unknown composition handle');
    const values = new Map<string, unknown>(), cleanup: (() => Promise<C.CleanupReport>)[] = [];
    let closing: Promise<C.CleanupReport> | undefined, closed = false;
    const services: C.ServiceAccess = { get(key) {
      const point = plan.points.get(key.id);
      if (closed || !point || key.scope !== scope.kind || point.scope !== key.scope || point.contractVersion !== key.contractVersion || !values.has(key.id)) return fail('service.missing', key.id, 'unsupported');
      return ok(values.get(key.id) as never);
    } };
    const context = localContext({ scope, services });
    const close = (): Promise<C.CleanupReport> => closing ??= (async () => {
      closed = true; const reports: C.CleanupReport[] = [];
      for (const dispose of cleanup.reverse()) { try { reports.push(await dispose()); } catch { reports.push({ ...emptyCleanup(), errors: [{ code: 'part.cleanup', category: 'internal', message: 'Cleanup failed', retry: 'never' }] }); } }
      values.clear(); return { released: reports.flatMap(r => r.released), unresolved: reports.flatMap(r => r.unresolved), errors: reports.flatMap(r => r.errors) };
    })();
    try {
      for (const [id, list] of plan.bindings) {
        const point = plan.points.get(id)!; if (point.scope !== scope.kind) continue;
        values.set(id, point.kind === 'service' ? list[0]?.value : point.kind === 'registry' ? new Map(list.map(b => [b.key!, b.value])) : Object.freeze(list.map(b => b.value)));
      }
      for (const id of plan.factoryOrder) {
        const factory = plan.factories.get(id)!; if (factory.scope !== scope.kind) continue;
        const created = await factory.create(plan.config, context);
        if (!created.ok) { const report = await close(); return { ok: false, error: { ...created.error, details: { cleanup: report as unknown as C.Json } } }; }
        values.set(id, created.value.value); cleanup.push(() => created.value.dispose());
      }
      for (const component of plan.components) {
        if (component.descriptor.scope !== scope.kind) continue;
        const created = component.create(plan.config, services); if (!created.ok) { await close(); return created; }
        const instance = created.value; cleanup.push(() => instance.dispose());
        const initialized = await instance.initialize(context); if (!initialized.ok) { await close(); return initialized; }
        cleanup.push(() => instance.stop('scope-close'));
        const started = await instance.start(context); if (!started.ok) { await close(); return started; }
      }
      return ok({ scope, services, close });
    } catch { const report = await close(); return fail('scope.open', `Scope initialization failed (${report.errors.length} cleanup errors)`, 'internal'); }
  } };
}
