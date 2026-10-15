/** @public */
import { canonical, fail, freeze, isJson, ok } from '@slop-lab/part/contracts';
import type { Contracts, Runtime, Workflows } from '@slop-lab/part/reference';
/** The native owner supplies scheduling, continuation, actions and recovery semantics. */
export interface NativeWorkflowPort {
  prepare(
    request: Workflows.PrepareRequest,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Omit<Workflows.Prepared, 'engine' | 'definition'>>>;
  submit(
    key: string,
    prepared: unknown,
    input: Contracts.Json,
    limits: Runtime.ExecutionLimits | undefined,
    context: Contracts.InvocationContext,
  ): Promise<
    | { kind: 'accepted'; native: Contracts.Json }
    | { kind: 'rejected'; error: Contracts.Failure }
    | { kind: 'unknown'; reconciliationKey: string; error: Contracts.Failure }
  >;
  get(
    native: Contracts.Json,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Omit<Workflows.Snapshot, 'ref'>>>;
  cancel(
    native: Contracts.Json,
    reason: string,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Runtime.Cancellation>>;
  observe(
    native: Contracts.Json,
    context: Contracts.InvocationContext,
  ): AsyncIterable<Runtime.Update>;
  action(
    native: Contracts.Json,
    command: Contracts.CommandRequest,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.CommandReceipt>;
  reconcile(
    key: string,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Contracts.Json | null>>;
}
export function createExternalEngine(
  descriptor: Workflows.EngineDescriptor,
  port: NativeWorkflowPort,
): Workflows.Engine {
  descriptor = freeze(structuredClone(descriptor));
  const prepared = new WeakMap<Workflows.Prepared, { local: unknown; principal: string }>();
  const executions = new Map<string, { ref: Workflows.ExecutionRef; principal: string }>();
  const submissions = new Map<
    string,
    { fingerprint: string; pending: Promise<Workflows.Submission> }
  >();
  const reconciliations = new Map<
    string,
    { nativeKey: string; principal: string; ref?: Workflows.ExecutionRef }
  >();
  function attach(
    native: Contracts.Json,
    context: Contracts.InvocationContext,
  ): Workflows.ExecutionRef {
    const principal = canonical(context.principal);
    const existing = [...executions.values()].find(
      (e) => e.principal === principal && canonical(e.ref.native!) === canonical(native),
    );
    if (existing) return existing.ref;
    const ref = freeze({
      engine: descriptor.id,
      engineVersion: descriptor.version,
      id: crypto.randomUUID(),
      native: structuredClone(native),
    });
    executions.set(ref.id, { ref, principal });
    return ref;
  }
  function resolve(
    ref: Workflows.ExecutionRef,
    context: Contracts.InvocationContext,
  ): Contracts.Result<Contracts.Json> {
    const entry = executions.get(ref.id);
    return entry &&
      entry.principal === canonical(context.principal) &&
      ref.engine === descriptor.id &&
      ref.engineVersion === descriptor.version &&
      canonical(ref as unknown as Contracts.Json) ===
        canonical(entry.ref as unknown as Contracts.Json)
      ? ok(entry.ref.native!)
      : fail(
          'external.permission',
          'Native execution reference is not owned by this adapter',
          'permission',
        );
  }
  const engine: Workflows.Engine = {
    descriptor,
    async prepare(request, context) {
      if (
        request.engineId !== descriptor.id ||
        !descriptor.formats.some(
          (f) =>
            f.id === request.definition.format &&
            f.versions.includes(request.definition.formatVersion),
        ) ||
        request.requiredCapabilities.some(
          (id) =>
            !descriptor.capabilities.entries.some((c) => c.id === id && c.status === 'supported'),
        )
      )
        return fail(
          'external.prepare',
          'Required native format or capability unavailable',
          'unsupported',
        );
      const result = await port.prepare(request, context);
      if (!result.ok) return result;
      if (
        request.requiredControl === 'runner-enforced' &&
        result.value.guarantees.control !== 'runner-enforced'
      )
        return fail('external.control', 'Native control guarantee is insufficient', 'unsupported');
      const value: Workflows.Prepared = Object.freeze({
        ...result.value,
        definition: freeze(structuredClone(request.definition)),
        engine: descriptor,
      });
      prepared.set(value, {
        local: result.value.localHandle,
        principal: canonical(context.principal),
      });
      return ok(value);
    },
    async start(request, context) {
      const installed = prepared.get(request.prepared);
      if (
        !installed ||
        installed.principal !== canonical(context.principal) ||
        !isJson(request.input) ||
        context.signal.aborted
      )
        return {
          kind: 'rejected',
          error: fail('external.token', 'Invalid prepared token or cancelled submission').error,
        };
      const key = canonical({
        principal: context.principal,
        key: request.idempotencyKey ?? request.requestId,
      });
      const fingerprint = canonical({
        definition: request.prepared.definition as unknown as Contracts.Json,
        input: request.input,
        limits: (request.limits as unknown as Contracts.Json) ?? null,
      });
      const prior = submissions.get(key);
      if (prior)
        return prior.fingerprint === fingerprint
          ? prior.pending
          : {
              kind: 'rejected',
              error: fail('external.dedupe', 'Submission key has different content', 'conflict')
                .error,
            };
      const input = structuredClone(request.input),
        limits = request.limits ? structuredClone(request.limits) : undefined;
      const pending: Promise<Workflows.Submission> = Promise.resolve().then(async () => {
        try {
          if (context.signal.aborted)
            return {
              kind: 'rejected',
              error: fail(
                'external.cancelled',
                'Submission cancelled before native admission',
                'cancelled',
              ).error,
            };
          const submitted = await port.submit(key, installed.local, input, limits, context);
          if (submitted.kind === 'rejected') return submitted;
          if (submitted.kind === 'unknown') {
            const reconciliationKey = crypto.randomUUID();
            reconciliations.set(reconciliationKey, {
              nativeKey: submitted.reconciliationKey,
              principal: canonical(context.principal),
            });
            return {
              kind: 'unknown',
              requestId: request.requestId,
              reconciliationKey,
              error: submitted.error,
            };
          }
          const ref = attach(submitted.native, context),
            snapshot = await engine.get(ref, context);
          if (snapshot.ok) return { kind: 'accepted', ref, snapshot: snapshot.value };
          const reconciliationKey = crypto.randomUUID();
          reconciliations.set(reconciliationKey, {
            nativeKey: key,
            principal: canonical(context.principal),
            ref,
          });
          return {
            kind: 'unknown',
            requestId: request.requestId,
            reconciliationKey,
            error: snapshot.error,
          };
        } catch {
          const reconciliationKey = crypto.randomUUID();
          reconciliations.set(reconciliationKey, {
            nativeKey: key,
            principal: canonical(context.principal),
          });
          return {
            kind: 'unknown',
            requestId: request.requestId,
            reconciliationKey,
            error: fail(
              'external.delivery',
              'Native submission outcome is unknown',
              'unavailable',
              'unknown',
            ).error,
          };
        }
      });
      submissions.set(key, { fingerprint, pending });
      return pending;
    },
    async get(ref, context) {
      const native = resolve(ref, context);
      if (!native.ok) return native;
      const snapshot = await port.get(native.value, context);
      return snapshot.ok ? ok({ ...snapshot.value, ref: executions.get(ref.id)!.ref }) : snapshot;
    },
    requestCancel(ref, reason, context) {
      const native = resolve(ref, context);
      return native.ok ? port.cancel(native.value, reason, context) : Promise.resolve(native);
    },
    observe(ref, context) {
      const native = resolve(ref, context);
      return native.ok
        ? port.observe(native.value, context)
        : { async *[Symbol.asyncIterator]() {} };
    },
    action(ref, command, context) {
      const native = resolve(ref, context);
      return native.ok
        ? port.action(native.value, command, context)
        : Promise.resolve({ kind: 'rejected', commandId: command.commandId, error: native.error });
    },
    async reconcileSubmission(key, context) {
      const pending = reconciliations.get(key);
      if (!pending || pending.principal !== canonical(context.principal))
        return fail(
          'external.reconcile',
          'Reconciliation key is not owned by this caller',
          'permission',
        );
      if (pending.ref) return ok(pending.ref);
      const resolved = await port.reconcile(pending.nativeKey, context);
      if (!resolved.ok) return resolved;
      if (resolved.value === null) return ok(null);
      pending.ref = attach(resolved.value, context);
      return ok(pending.ref);
    },
  };
  return engine;
}
