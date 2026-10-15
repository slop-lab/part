import { commandSchema, querySchema } from '../client/control.js';
import { createWatchHub } from '../client/watch.js';
import { canonical, fail, freeze, isJsonObject, ok } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
import type { Contracts } from '../reference/contracts.js';
import type { ControlCatalog } from '../reference/control-catalog.js';
import type { Projection } from '../reference/projection.js';
import type { Workflows } from '../reference/workflows.js';
export interface WorkflowRegistration {
  readonly definition: Workflows.DefinitionRef;
  readonly engineId: string;
  readonly profileIds: readonly string[];
}
/** Wire callers select registered definitions. Executables and Prepared tokens stay local. */
export function createWorkflowEndpoint(options: {
  host: Workflows.Host;
  registrations: readonly WorkflowRegistration[];
  composition: { id: string; revision: string };
  context: Contracts.InvocationContext;
  project?: (
    snapshot: Workflows.Snapshot,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<Projection.Item>>;
}): Contracts.Result<
  Client.Endpoint & {
    hub: ReturnType<typeof createWatchHub>;
    close(): Promise<Contracts.CleanupReport>;
  }
> {
  const registrations = new Map(
    options.registrations.map((r) => [
      `${r.engineId}/${r.definition.id}`,
      freeze(structuredClone(r)),
    ]),
  );
  if (registrations.size !== options.registrations.length)
    return fail('workflow.registration', 'Duplicate workflow registration');
  const rootCancellation = new AbortController(),
    observerCancellation = new AbortController();
  const root = {
    ...options.context,
    signal: AbortSignal.any([options.context.signal, rootCancellation.signal]),
  };
  const observeContext = {
    ...root,
    signal: AbortSignal.any([root.signal, observerCancellation.signal]),
  };
  const composition = { ...options.composition };
  const capabilities: Contracts.CapabilitySet = {
    revision: composition.revision,
    entries: [
      {
        id: 'part/workflow-endpoint',
        contractVersion: 1,
        status: 'supported',
        implementedBy: 'part/workflow-endpoint',
        constraints: { dedupe: 'memory', audience: 'single-principal', rawNativeState: false },
      },
    ],
  };
  const hub = createWatchHub(capabilities),
    executions = new Map<string, { ref: Workflows.ExecutionRef; engine: Workflows.Engine }>();
  const receipts = new Map<
      string,
      { fingerprint: string; result: Promise<Contracts.CommandReceipt> }
    >(),
    observations = new Set<Promise<void>>(),
    admissions = new Set<Promise<Contracts.CommandReceipt>>();
  const unknown = new Map<string, { engine: Workflows.Engine; key: string }>();
  let closed = false;
  const allowed = (c: Contracts.InvocationContext) =>
    !closed && canonical(root.principal) === canonical(c.principal);
  const reject = (
    commandId: string,
    message: string,
    category: Contracts.Failure['category'] = 'validation',
  ): Contracts.CommandReceipt => ({
    kind: 'rejected',
    commandId,
    error: fail('workflow.endpoint', message, category).error,
  });
  const completed = (commandId: string, result: Contracts.Json): Contracts.CommandReceipt => ({
    kind: 'completed',
    commandId,
    result,
    effect: 'not-applicable',
    commit: [],
  });
  const entity = (ref: Workflows.ExecutionRef): Contracts.EntityRef => ({
    owner: ref.engine,
    kind: 'part/workflow',
    id: ref.id,
  });
  const lookup = (target?: Contracts.EntityRef) => {
    const entry = target && executions.get(target.id);
    return entry && target?.owner === entry.ref.engine && target.kind === 'part/workflow'
      ? entry
      : undefined;
  };
  async function publish(entry: { ref: Workflows.ExecutionRef; engine: Workflows.Engine }) {
    const result = await entry.engine.get(entry.ref, root);
    if (!result.ok || closed) return;
    const snapshot = result.value;
    if (options.project) {
      const projected = await options.project(snapshot, root);
      if (projected.ok) hub.upsert(projected.value);
      return;
    }
    const inspected = await entry.engine.inspect?.(entry.ref, 'waits', root);
    const waits = inspected?.ok ? inspected.value.data : [];
    const payload = {
      phase: snapshot.phase,
      effect: snapshot.effect,
      guarantees: snapshot.guarantees,
      definitionDigest: snapshot.definitionDigest,
      ...(snapshot.output ? { output: snapshot.output } : {}),
      waits,
    } as unknown as Contracts.Json;
    const actions = [...snapshot.actions];
    if (!['succeeded', 'failed', 'cancelled'].includes(snapshot.phase))
      actions.push({
        id: 'part.workflow/cancel',
        version: 1,
        input: { id: 'part/null', version: 1 },
        output: { id: 'part/json', version: 1 },
        execution: 'immediate',
        availability: { state: 'available', checkedAt: snapshot.revision },
      });
    hub.upsert({
      id: snapshot.ref.id,
      type: 'part/workflow',
      schemaVersion: 1,
      revision: snapshot.revision,
      source: entity(entry.ref),
      payload,
      fallback: {
        label: 'Workflow',
        text: `${snapshot.phase} · effect ${snapshot.effect}${snapshot.output ? '\n' + JSON.stringify(snapshot.output) : ''}`,
      },
      actions,
      artifacts: [],
    });
  }
  async function track(ref: Workflows.ExecutionRef) {
    const engine = options.host.resolve(ref.engine);
    if (!engine.ok) return;
    if (executions.has(ref.id)) {
      await publish(executions.get(ref.id)!);
      return;
    }
    const entry = { ref: freeze(structuredClone(ref)), engine: engine.value };
    executions.set(ref.id, entry);
    const observation = (async () => {
      const iterator = entry.engine.observe(ref, observeContext)[Symbol.asyncIterator]();
      // Register observation before reading the authoritative snapshot.
      let next = iterator.next();
      try {
        await publish(entry);
        while (!observerCancellation.signal.aborted) {
          const update = await next;
          if (update.done) break;
          next = iterator.next();
          await publish(entry);
        }
        await publish(entry);
      } catch {
        /* Snapshot queries remain authoritative after an observation failure. */
      } finally {
        await iterator.return?.();
      }
    })();
    observations.add(observation);
    void observation.finally(() => observations.delete(observation));
    await publish(entry);
  }
  async function command(request: Contracts.CommandRequest): Promise<Contracts.CommandReceipt> {
    if (request.actionVersion !== 1)
      return reject(request.commandId, 'Action version unavailable', 'unsupported');
    if (request.actionId === 'part.workflow/start') {
      const input = request.input;
      if (
        !isJsonObject(input) ||
        Object.keys(input).some(
          (k) =>
            ![
              'engineId',
              'definition',
              'profileId',
              'composition',
              'input',
              'limits',
              'requiredControl',
              'requiredCapabilities',
            ].includes(k),
        ) ||
        typeof input.engineId !== 'string' ||
        typeof input.profileId !== 'string' ||
        !isJsonObject(input.definition) ||
        typeof input.definition.id !== 'string' ||
        !isJsonObject(input.composition) ||
        !Array.isArray(input.requiredCapabilities) ||
        input.requiredCapabilities.some((c) => typeof c !== 'string') ||
        !['instruction-only', 'runner-enforced'].includes(String(input.requiredControl)) ||
        !Object.hasOwn(input, 'input')
      )
        return reject(request.commandId, 'Invalid workflow start input');
      const registration = registrations.get(`${input.engineId}/${input.definition.id}`);
      if (
        !registration ||
        registration.definition.digest !== input.definition.digest ||
        !registration.profileIds.includes(input.profileId) ||
        canonical(input.composition) !== canonical(composition)
      )
        return reject(
          request.commandId,
          'Definition, digest, profile or composition is unavailable',
          'permission',
        );
      const selected = input as unknown as ControlCatalog.WorkflowStartInput;
      const prepared = await options.host.prepare(
        {
          definition: registration.definition,
          engineId: selected.engineId,
          profileId: selected.profileId,
          requiredCapabilities: selected.requiredCapabilities,
          requiredControl: selected.requiredControl,
        },
        root,
      );
      if (!prepared.ok)
        return { kind: 'rejected', commandId: request.commandId, error: prepared.error };
      if (closed || root.signal.aborted)
        return reject(request.commandId, 'Endpoint closed during admission');
      const submitted = await options.host.start(
        {
          requestId: request.commandId,
          idempotencyKey: request.idempotencyKey ?? request.commandId,
          prepared: prepared.value,
          input: selected.input,
          ...(selected.limits ? { limits: selected.limits } : {}),
        },
        root,
      );
      if (submitted.kind === 'accepted') {
        await track(submitted.ref);
        return {
          kind: 'accepted',
          commandId: request.commandId,
          operation: entity(submitted.ref),
          commit: [],
        };
      }
      if (submitted.kind === 'unknown') {
        const engine = options.host.resolve(selected.engineId);
        if (engine.ok)
          unknown.set(request.commandId, {
            engine: engine.value,
            key: submitted.reconciliationKey,
          });
        return {
          kind: 'failed',
          commandId: request.commandId,
          error: submitted.error,
          effect: 'unknown',
          commit: [],
        };
      }
      return { kind: 'rejected', commandId: request.commandId, error: submitted.error };
    }
    if (request.actionId === 'part.workflow/reconcile') {
      if (typeof request.input !== 'string')
        return reject(request.commandId, 'Expected original command ID');
      const pending = unknown.get(request.input);
      if (!pending?.engine.reconcileSubmission)
        return reject(request.commandId, 'Submission reconciliation unavailable', 'unsupported');
      const reconciled = await pending.engine.reconcileSubmission(pending.key, root);
      if (!reconciled.ok)
        return {
          kind: 'failed',
          commandId: request.commandId,
          error: reconciled.error,
          effect: 'unknown',
          commit: [],
        };
      if (reconciled.value) {
        await track(reconciled.value);
        unknown.delete(request.input);
      }
      return completed(request.commandId, reconciled.value as unknown as Contracts.Json);
    }
    const entry = lookup(request.target);
    if (!entry) return reject(request.commandId, 'Workflow target not found', 'permission');
    const snapshot = await entry.engine.get(entry.ref, root);
    if (!snapshot.ok)
      return { kind: 'rejected', commandId: request.commandId, error: snapshot.error };
    for (const precondition of request.preconditions?.versions ?? [])
      if (
        canonical(precondition.ref as unknown as Contracts.Json) !==
          canonical(entity(entry.ref) as unknown as Contracts.Json) ||
        precondition.expected !== snapshot.value.revision
      )
        return reject(request.commandId, 'Workflow precondition failed', 'conflict');
    if (request.actionId === 'part.workflow/cancel') {
      if (request.input !== null) return reject(request.commandId, 'Cancel expects null');
      const result = await entry.engine.requestCancel(entry.ref, 'client-request', root);
      await publish(entry);
      return result.ok
        ? completed(request.commandId, result.value as unknown as Contracts.Json)
        : { kind: 'rejected', commandId: request.commandId, error: result.error };
    }
    const action = snapshot.value.actions.find(
      (a) =>
        a.id === request.actionId &&
        a.version === request.actionVersion &&
        a.availability.state === 'available',
    );
    if (!action) return reject(request.commandId, 'Workflow action unavailable', 'unsupported');
    const receipt = await entry.engine.action(entry.ref, request, root);
    await publish(entry);
    return receipt;
  }
  return ok({
    hub,
    async command(request, caller) {
      if (!allowed(caller))
        return reject(request.commandId, 'Endpoint access denied', 'permission');
      if (!commandSchema.validate(request).ok)
        return reject(request.commandId, 'Invalid command envelope');
      const fixed = freeze(structuredClone(request)),
        key = request.idempotencyKey ?? request.commandId;
      const fingerprint = canonical({ ...fixed, commandId: '' } as unknown as Contracts.Json);
      const prior = receipts.get(key);
      if (prior)
        return prior.fingerprint === fingerprint
          ? { ...(await prior.result), commandId: request.commandId }
          : reject(request.commandId, 'Command key has different content', 'conflict');
      if (receipts.size >= 1000)
        return reject(request.commandId, 'Command receipt capacity reached');
      const result = Promise.resolve()
        .then(() => command(fixed))
        .catch(() => ({
          kind: 'failed' as const,
          commandId: fixed.commandId,
          error: fail(
            'workflow.endpoint-exception',
            'Workflow endpoint failed',
            'internal',
            'unknown',
          ).error,
          effect: 'unknown' as const,
          commit: [],
        }));
      receipts.set(key, { fingerprint, result });
      admissions.add(result);
      void result.finally(() => admissions.delete(result));
      return result;
    },
    async query(request, caller) {
      if (!allowed(caller))
        return fail('workflow.permission', 'Endpoint access denied', 'permission');
      if (!querySchema.validate(request).ok || request.version !== 1)
        return fail('workflow.query', 'Invalid query');
      if (request.queryId === 'part/capabilities')
        return ok(capabilities as unknown as Contracts.Json);
      if (request.queryId === 'part.workflow/definitions')
        return ok(
          [...registrations.values()].map((r) => ({
            engineId: r.engineId,
            definition: { id: r.definition.id, digest: r.definition.digest },
            profileIds: r.profileIds,
            composition,
          })) as unknown as Contracts.Json,
        );
      const entry = lookup(request.target);
      if (!entry) return fail('workflow.target', 'Workflow target unavailable', 'permission');
      if (request.queryId === 'part.workflow/get') {
        await publish(entry);
        const snapshot = hub.snapshot().items.find((item) => item.id === entry.ref.id);
        return snapshot
          ? ok(snapshot as unknown as Contracts.Json)
          : fail('workflow.projection', 'Workflow projection unavailable');
      }
      if (request.queryId === 'part/actions') {
        await publish(entry);
        return ok(
          (hub.snapshot().items.find((item) => item.id === entry.ref.id)
            ?.actions as unknown as Contracts.Json) ?? [],
        );
      }
      return fail('workflow.query', 'Query unavailable', 'unsupported');
    },
    async watch(_request, caller) {
      return allowed(caller)
        ? hub.watch(caller)
        : fail('workflow.permission', 'Endpoint access denied', 'permission');
    },
    async close() {
      if (closed) return { released: [], unresolved: [], errors: [] };
      closed = true;
      rootCancellation.abort('endpoint-closed');
      observerCancellation.abort('endpoint-closed');
      await Promise.all([...admissions]);
      const errors: Contracts.Failure[] = [],
        unresolved: Contracts.EntityRef[] = [],
        released: Contracts.EntityRef[] = [];
      for (const entry of executions.values()) {
        const result = await entry.engine.requestCancel(
          entry.ref,
          'endpoint-closed',
          options.context,
        );
        if (!result.ok) errors.push(result.error);
        const snapshot = await entry.engine.get(entry.ref, options.context);
        if (
          snapshot.ok &&
          ['succeeded', 'failed', 'cancelled'].includes(snapshot.value.phase) &&
          !snapshot.value.activeOperations.length
        )
          released.push(entity(entry.ref));
        else unresolved.push(entity(entry.ref));
      }
      // External engines may not confirm cleanup; report those references honestly.
      hub.close();
      return { released, unresolved, errors };
    },
  });
}
