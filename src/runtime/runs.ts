import { isCompositionHandle } from '../composition/index.js';
import type { RunHistoryAttachment, RunHistoryLease } from '../context/run-history.js';
import { canonical, emptyCleanup, fail, ok } from '../foundation/contracts.js';
import { budgetKey } from '../model/gateway.js';
import type { Contracts, Driver, Runtime } from '../reference/index.js';
import { numericLimits } from './budgets.js';
import { costServices } from './costs.js';
import type { Operations } from './index.js';
import { createBudget } from './index.js';

interface DriverBinding {
  readonly id: string;
  readonly requires: Driver.Factory<unknown, unknown>['requires'];
  validate(input: unknown): Contracts.Result<unknown>;
  create(services: Driver.Services, ref: Contracts.EntityRef): Driver.Instance<unknown, unknown>;
}
export interface InstalledDriver {
  readonly id: string;
  readonly binding: unknown;
}
const drivers = new WeakMap<object, DriverBinding>();
export function installDriver<I, O>(factory: Driver.Factory<I, O>): InstalledDriver {
  const binding = {};
  drivers.set(binding, {
    id: factory.id,
    requires: factory.requires.map((r) => ({ ...r })),
    validate(input) {
      const checked = factory.input.validate(input);
      return checked.ok ? ok(checked.value) : fail('run.input', 'Driver input validation failed');
    },
    create(services, ref) {
      const instance = factory.create(services, ref);
      return {
        ...instance,
        async execute(input, context) {
          const checked = factory.input.validate(input);
          if (!checked.ok)
            return {
              phase: 'failed',
              error: {
                code: 'part.run.input',
                category: 'validation',
                message: 'Driver input validation failed',
                retry: 'never',
              },
              effect: 'not-attempted',
              unsettledChildren: [],
              commit: [],
            };
          const result = await instance.execute(checked.value, context);
          if (result.phase !== 'completed') return result;
          const output = factory.output.validate(result.result);
          return output.ok
            ? { ...result, result: output.value }
            : {
                phase: 'failed',
                error: {
                  code: 'part.run.output',
                  category: 'validation',
                  message: 'Driver output validation failed',
                  retry: 'never',
                },
                effect: result.effect,
                unsettledChildren: result.unsettledChildren,
                commit: result.commit,
              };
        },
      };
    },
  });
  return Object.freeze({ id: factory.id, binding });
}
export interface RunControlService extends Runtime.RunService {
  describeActions(
    ref: Contracts.EntityRef,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<readonly Contracts.ActionDescriptor[]>>;
  receive(
    ref: Contracts.EntityRef,
    actionId: string,
    version: number,
    input: unknown,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Driver.InputReceipt>>;
}
export function createRunService(options: {
  drivers: readonly InstalledDriver[];
  services: Driver.Services;
  operations: Operations;
  history?: RunHistoryAttachment;
}): Contracts.Result<RunControlService> {
  const registry = new Map<string, DriverBinding>(),
    runs = new Map<string, { handle: Runtime.ExecutionHandle<unknown>; principal: string }>();
  const instances = new Map<
    string,
    { instance: Driver.Instance<unknown, unknown>; context: Contracts.InvocationContext }
  >();
  const owned = (ref: Contracts.EntityRef, context: Contracts.InvocationContext) => {
    const record = runs.get(ref.id);
    return record &&
      record.principal === canonical(context.principal) &&
      ref.owner === record.handle.ref.owner &&
      ref.kind === record.handle.ref.kind
      ? record.handle
      : undefined;
  };
  for (const installed of options.drivers) {
    const binding =
      installed.binding && typeof installed.binding === 'object'
        ? drivers.get(installed.binding)
        : undefined;
    if (!binding || binding.id !== installed.id)
      return fail('driver.binding', 'Invalid driver binding');
    if (registry.has(binding.id)) return fail('driver.duplicate', binding.id, 'conflict');
    registry.set(binding.id, binding);
  }
  return ok({
    async start(request, context) {
      request = {
        ...request,
        ...(request.parent ? { parent: { ...request.parent } } : {}),
        ...(request.history ? { history: { ...request.history } } : {}),
        ...(request.limits ? { limits: structuredClone(request.limits) } : {}),
      };
      if (!isCompositionHandle(request.composition))
        return fail('run.composition', 'A resolved local composition handle is required');
      const driver = registry.get(request.driver);
      if (!driver) return fail('driver.missing', request.driver, 'unsupported');
      if (request.history && !options.history)
        return fail(
          'run.history',
          'History attachment is not installed; use the history service explicitly',
          'unsupported',
        );

      for (const requirement of driver.requires)
        if (
          !request.composition.inspection.capabilities.entries.some(
            (c) =>
              c.id === requirement.id &&
              c.contractVersion === requirement.contractVersion &&
              c.status === 'supported',
          ) &&
          !requirement.optional
        )
          return fail('driver.requirement', requirement.id, 'unsupported');
      const input = driver.validate(request.input);
      if (!input.ok) return input;
      let fixed: unknown;
      try {
        fixed = structuredClone(input.value);
      } catch {
        return fail('run.input', 'Run input is not cloneable');
      }
      const parsedLimits = numericLimits(request.limits);
      if (!parsedLimits.ok) return parsedLimits;
      const limits = parsedLimits.value;
      const budget = createBudget(limits),
        upstream = context.services.get(budgetKey);
      const services: Contracts.ServiceAccess = {
        get(key) {
          if (key.id !== budgetKey.id) return context.services.get(key);
          const port: Runtime.BudgetPort = {
            reserve(dimension, quantity) {
              const child = budget.reserve(dimension, quantity);
              if (!child.ok || !upstream.ok) return child;
              const parent = upstream.value.reserve(dimension, quantity);
              if (!parent.ok) {
                budget.settle(child.value, 0);
                return parent;
              }
              paired.set(child.value, parent.value);
              return child;
            },
            settle(reservation, actual) {
              const child = budget.settle(reservation, actual);
              const parent = paired.get(reservation);
              if (parent && upstream.ok) {
                paired.delete(reservation);
                const settled = upstream.value.settle(parent, actual);
                if (!settled.ok) return settled;
              }
              return child;
            },
          };
          return ok(port as never);
        },
      };
      const paired = new WeakMap<Runtime.BudgetReservation, Runtime.BudgetReservation>();
      if (upstream.ok) {
        const admitted = upstream.value.reserve('maxChildRuns', 1);
        if (!admitted.ok) return admitted;
      }
      const deadlines = [context.deadline, request.limits?.deadline]
        .filter((v): v is string => !!v)
        .map(Date.parse);
      if (deadlines.some(Number.isNaN)) return fail('run.deadline', 'Invalid deadline');
      const guardedServices = costServices(context, services, request.limits);
      if (!guardedServices.ok) return guardedServices;
      const fixedContext = {
        ...context,
        services: guardedServices.value,
        compositionRevision: request.composition.inspection.revision,
        ...(deadlines.length ? { deadline: new Date(Math.min(...deadlines)).toISOString() } : {}),
      };
      let historyLease: RunHistoryLease | undefined;
      if (request.history) {
        const attached = await options.history!.prepare(
          { ...request.history },
          fixed,
          fixedContext,
        );
        if (!attached.ok) return attached;
        historyLease = attached.value;
        const checked = driver.validate(historyLease.input);
        if (!checked.ok) {
          historyLease.release();
          return checked;
        }
        try {
          fixed = structuredClone(checked.value);
        } catch {
          historyLease.release();
          return fail('history.input', 'Attached input is not cloneable');
        }
      }
      const created = await options.operations.begin(
        {
          kind: 'part/run',
          retryOwner: 'part/driver',
          childPolicy: 'attached',
          ...(request.parent ? { parent: request.parent } : {}),
        },
        async (c) => {
          const ref: Contracts.EntityRef = {
            owner: 'part/operations',
            kind: 'part/run',
            id: c.scope.id,
          };
          let instance: Driver.Instance<unknown, unknown> | undefined;
          let outcome: Runtime.ManagedOutcome<unknown> = {
            phase: 'failed',
            error: fail('run.exception', 'Driver execution failed', 'internal', 'unknown').error,
            effect: 'unknown',
            commit: [],
            unsettledChildren: [],
          };
          try {
            instance = driver.create({ ...options.services, services: guardedServices.value }, ref);
            instances.set(ref.id, { instance, context: c });
            outcome = await instance.execute(fixed, c);
            if (historyLease) {
              const saved = await historyLease.finish(outcome, c);
              if (!saved.ok)
                outcome = {
                  phase: 'failed',
                  error: saved.error,
                  effect: outcome.effect,
                  commit: outcome.commit,
                  unsettledChildren: outcome.unsettledChildren,
                };
              else outcome = { ...outcome, commit: [...outcome.commit, ...saved.value] };
            }
          } catch {
            outcome = {
              phase: 'failed',
              error: fail('run.exception', 'Driver execution failed', 'internal', 'unknown').error,
              effect: 'unknown',
              commit: [],
              unsettledChildren: [],
            };
          } finally {
            historyLease?.release();
            instances.delete(ref.id);
            const cleaned = await Promise.resolve()
              .then(() => instance?.dispose() ?? emptyCleanup())
              .catch(() => ({
                released: [],
                unresolved: [{ owner: driver.id, kind: 'part/driver-instance', id: ref.id }],
                errors: [
                  fail('run.dispose', 'Driver disposal failed', 'internal', 'unknown').error,
                ],
              }));
            if (cleaned.errors.length || cleaned.unresolved.length) {
              outcome = {
                phase: cleaned.unresolved.length ? 'abandoned' : 'failed',
                error: fail(
                  'run.cleanup',
                  'Driver cleanup did not complete',
                  'unavailable',
                  cleaned.unresolved.length ? 'unknown' : outcome.effect,
                ).error,
                effect: cleaned.unresolved.length ? 'unknown' : outcome.effect,
                commit: outcome.commit,
                unsettledChildren: [...outcome.unsettledChildren, ...cleaned.unresolved],
              };
              c.progress.publish('part.run/cleanup', cleaned as unknown as Contracts.Json);
            }
          }
          return outcome;
        },
        fixedContext,
      );
      if (!created.ok) historyLease?.release();
      if (created.ok)
        runs.set(created.value.ref.id, {
          handle: created.value,
          principal: canonical(context.principal),
        });
      return created;
    },
    async get(ref, context) {
      const handle = owned(ref, context);
      return handle && ref.owner === handle.ref.owner
        ? ok(handle.snapshot())
        : fail('run.missing', ref.id);
    },
    async cancel(ref, reason, context) {
      const handle = owned(ref, context);
      return handle && ref.owner === handle.ref.owner
        ? handle.requestCancel(reason)
        : fail('run.missing', ref.id);
    },
    async describeActions(ref, context) {
      const handle = owned(ref, context),
        entry = instances.get(ref.id);
      return handle && entry
        ? ok(entry.instance.describeActions(entry.context))
        : fail('run.actions', 'Run actions unavailable', 'permission');
    },
    async receive(ref, actionId, version, input, context) {
      const handle = owned(ref, context),
        entry = instances.get(ref.id);
      if (!handle || !entry || entry.context.signal.aborted)
        return fail('run.receive', 'Run input is unavailable', 'permission');
      const action = entry.instance
        .describeActions(entry.context)
        .find(
          (action) =>
            action.id === actionId &&
            action.version === version &&
            action.availability.state === 'available',
        );
      if (!action) return fail('run.action', 'Driver action/version unavailable', 'unsupported');
      return entry.instance.receive(actionId, input, entry.context);
    },
  });
}
