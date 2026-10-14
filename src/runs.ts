import type { Contracts as C, Runtime as R, Driver as D } from './reference.js';
import type { Operations } from './runtime.js';
import { ok, fail, emptyCleanup } from './contracts.js';
import { createBudget } from './runtime.js';
import { budgetKey } from './model.js';

interface DriverBinding { readonly id: string; readonly requires: D.Factory<unknown, unknown>['requires']; validate(input: unknown): C.Result<unknown>; create(services: D.Services, ref: C.EntityRef): D.Instance<unknown, unknown> }
export interface InstalledDriver { readonly id: string; readonly binding: unknown }
const drivers = new WeakMap<object, DriverBinding>();
export function installDriver<I, O>(factory: D.Factory<I, O>): InstalledDriver {
  const binding = {};
  drivers.set(binding, { id: factory.id, requires: factory.requires.map(r => ({ ...r })), validate(input) { const checked = factory.input.validate(input); return checked.ok ? ok(checked.value) : fail('run.input', 'Driver input validation failed'); },
    create(services, ref) {
      const instance = factory.create(services, ref);
      return { ...instance, async execute(input, context) {
        const checked = factory.input.validate(input); if (!checked.ok) return { phase: 'failed', error: { code: 'part.run.input', category: 'validation', message: 'Driver input validation failed', retry: 'never' }, effect: 'not-attempted', unsettledChildren: [], commit: [] };
        const result = await instance.execute(checked.value, context);
        if (result.phase !== 'completed') return result;
        const output = factory.output.validate(result.result);
        return output.ok ? { ...result, result: output.value } : { phase: 'failed', error: { code: 'part.run.output', category: 'validation', message: 'Driver output validation failed', retry: 'never' }, effect: result.effect, unsettledChildren: result.unsettledChildren, commit: result.commit };
      } };
    } });
  return Object.freeze({ id: factory.id, binding });
}
export function createRunService(options: { drivers: readonly InstalledDriver[]; services: D.Services; operations: Operations }): C.Result<R.RunService> {
  const registry = new Map<string, DriverBinding>(), runs = new Map<string, R.ExecutionHandle<unknown>>();
  for (const installed of options.drivers) {
    const binding = installed.binding && typeof installed.binding === 'object' ? drivers.get(installed.binding) : undefined;
    if (!binding || binding.id !== installed.id) return fail('driver.binding', 'Invalid driver binding');
    if (registry.has(binding.id)) return fail('driver.duplicate', binding.id, 'conflict'); registry.set(binding.id, binding);
  }
  return ok({ async start(request, context) {
    const driver = registry.get(request.driver); if (!driver) return fail('driver.missing', request.driver, 'unsupported');
    if (request.history) return fail('run.history', 'History attachment is not installed; use the history service explicitly', 'unsupported');
    if (request.limits?.estimatedCostCeiling) return fail('run.cost-budget', 'Estimated cost budgets are not supported', 'unsupported');
    for (const requirement of driver.requires) if (!request.composition.inspection.capabilities.entries.some(c => c.id === requirement.id && c.contractVersion === requirement.contractVersion && c.status === 'supported') && !requirement.optional) return fail('driver.requirement', requirement.id, 'unsupported');
    const input = driver.validate(request.input); if (!input.ok) return input;
    let fixed: unknown; try { fixed = structuredClone(input.value); } catch { return fail('run.input', 'Run input is not cloneable'); }
    const limits: Record<string, number> = {};
    for (const [key, value] of Object.entries(request.limits ?? {})) if (key !== 'deadline') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('run.limit', `Invalid limit ${key}`); limits[key] = value;
    }
    const budget = createBudget(limits), upstream = context.services.get(budgetKey);
    const services: C.ServiceAccess = { get(key) {
      if (key.id !== budgetKey.id) return context.services.get(key);
      const port: R.BudgetPort = { reserve(dimension, quantity) {
        const child = budget.reserve(dimension, quantity); if (!child.ok || !upstream.ok) return child;
        const parent = upstream.value.reserve(dimension, quantity); if (!parent.ok) { budget.settle(child.value, 0); return parent; }
        paired.set(child.value, parent.value); return child;
      }, settle(reservation, actual) { const child = budget.settle(reservation, actual); const parent = paired.get(reservation); if (parent && upstream.ok) { paired.delete(reservation); const settled = upstream.value.settle(parent, actual); if (!settled.ok) return settled; } return child; } };
      return ok(port as never);
    } };
    const paired = new WeakMap<R.BudgetReservation, R.BudgetReservation>();
    if (upstream.ok) { const admitted = upstream.value.reserve('maxChildRuns', 1); if (!admitted.ok) return admitted; }
    const deadlines = [context.deadline, request.limits?.deadline].filter((v): v is string => !!v).map(Date.parse);
    if (deadlines.some(Number.isNaN)) return fail('run.deadline', 'Invalid deadline');
    const fixedContext = { ...context, services, ...(deadlines.length ? { deadline: new Date(Math.min(...deadlines)).toISOString() } : {}) };
    const created = await options.operations.begin({ kind: 'part/run', retryOwner: 'part/driver', childPolicy: 'attached', ...(request.parent ? { parent: request.parent } : {}) }, async c => {
      const ref: C.EntityRef = { owner: 'part/operations', kind: 'part/run', id: c.scope.id };
      const instance = driver.create({ ...options.services, services }, ref);
      let outcome: R.ManagedOutcome<unknown>;
      try { outcome = await instance.execute(fixed, c); }
      finally { const cleaned = await instance.dispose(); if (cleaned.errors.length || cleaned.unresolved.length) c.progress.publish('part.run/cleanup', cleaned as unknown as C.Json); }
      return outcome;
    }, fixedContext);
    if (created.ok) runs.set(created.value.ref.id, created.value);
    return created;
  }, async get(ref) { const handle = runs.get(ref.id); return handle && ref.owner === handle.ref.owner ? ok(handle.snapshot()) : fail('run.missing', ref.id); },
  async cancel(ref, reason) { const handle = runs.get(ref.id); return handle && ref.owner === handle.ref.owner ? handle.requestCancel(reason) : fail('run.missing', ref.id); } });
}
