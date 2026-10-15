import type { Contracts, Scripts, Runtime } from './reference.js';
import { ok, fail, canonical, freeze, isJson, isJsonObject } from './contracts.js';
import { createBudget, budgetKey } from './runtime.js';
import { numericLimits } from './budgets.js';
import { costServices } from './costs.js';
import { scheduleDeadline } from './deadline.js';
export interface BridgeMethod {
  readonly profileRequired?: boolean;
  invoke(
    params: Contracts.Json,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.CommandReceipt>;
}
export interface ManagedBridge extends Scripts.BridgeHost {
  authenticate(
    grantId: string,
    credential: string,
    audience: string,
  ): Contracts.Result<Contracts.InvocationContext>;
  grant(
    grantId: string,
    context: Contracts.InvocationContext,
  ): Contracts.Result<Scripts.BridgeGrant>;
  credential(grantId: string, context: Contracts.InvocationContext): Contracts.Result<string>;
  close(): void;
}
/** Trusted methods are supplied by the host, never loaded from a script request. */
export function createScriptBridge(
  methods: Readonly<Record<string, BridgeMethod>>,
  capacity = 1000,
): ManagedBridge {
  const registry = { ...methods };
  const grants = new Map<
    string,
    {
      grant: Scripts.BridgeGrant;
      context: Contracts.InvocationContext;
      credential: string;
      controller: AbortController;
      release(): void;
      receipts: Map<string, { fingerprint: string; result: Promise<Contracts.CommandReceipt> }>;
    }
  >();
  let closed = false;
  const denied = (id: string, code: string, message: string): Contracts.CommandReceipt => ({
    kind: 'rejected',
    commandId: id,
    error: fail(code, message, 'permission').error,
  });
  const same = (a: Contracts.InvocationContext, b: Contracts.InvocationContext) =>
    canonical(a.principal) === canonical(b.principal);
  const live = (id: string) => {
    const entry = grants.get(id);
    return entry && !entry.controller.signal.aborted && !closed ? entry : undefined;
  };
  const revoke = (id: string) => {
    const entry = grants.get(id);
    if (entry) {
      entry.controller.abort('bridge-revoked');
      entry.release();
      grants.delete(id);
    }
  };
  return {
    async issue(policy, context) {
      if (closed || context.signal.aborted || grants.size >= capacity)
        return fail('bridge.closed', 'Bridge cannot admit another grant');
      if (
        !isJson(policy) ||
        policy.version !== 1 ||
        !policy.audience ||
        policy.owner.id !== context.scope.id ||
        !policy.allowedMethods.length ||
        policy.allowedMethods.some((id) => !Object.hasOwn(registry, id))
      )
        return fail('bridge.policy', 'Invalid owner, method, or grant policy');
      if (!['trusted-code-only', 'authenticated-channel'].includes(policy.enforcement))
        return fail('bridge.enforcement', 'Unknown bridge enforcement');
      const parsed = numericLimits(policy.limits);
      if (!parsed.ok) return parsed;
      const limits = parsed.value;
      const times = [policy.expiresAt, policy.limits.deadline, context.deadline]
        .filter((x): x is string => x !== undefined)
        .map(Date.parse);
      if (times.some(Number.isNaN) || Math.min(...times) <= Date.now())
        return fail('bridge.expiry', 'Invalid or expired grant');
      const expiry = new Date(Math.min(...times)).toISOString();
      const fixed = structuredClone(policy) as Omit<Scripts.BridgeGrant, 'id'>;
      const grant = freeze({
        ...fixed,
        id: crypto.randomUUID(),
        expiresAt: expiry,
        limits: { ...fixed.limits, deadline: expiry },
      });
      const controller = new AbortController(),
        local = createBudget(limits),
        upstream = context.services.get(budgetKey),
        pairs = new WeakMap<Runtime.BudgetReservation, Runtime.BudgetReservation>();
      const port: Runtime.BudgetPort = {
        reserve(dimension, quantity) {
          const child = local.reserve(dimension, quantity);
          if (!child.ok || !upstream.ok) return child;
          const parent = upstream.value.reserve(dimension, quantity);
          if (!parent.ok) {
            local.settle(child.value, 0);
            return parent;
          }
          pairs.set(child.value, parent.value);
          return child;
        },
        settle(reservation, actual) {
          const child = local.settle(reservation, actual);
          if (!child.ok) return child;
          const parent = pairs.get(reservation);
          pairs.delete(reservation);
          return parent && upstream.ok ? upstream.value.settle(parent, actual) : child;
        },
      };
      const services: Contracts.ServiceAccess = {
        get(key) {
          return key.id === budgetKey.id ? ok(port as never) : context.services.get(key);
        },
      };
      const guarded = costServices(context, services, fixed.limits);
      if (!guarded.ok) return guarded;
      const caller = {
        ...context,
        services: guarded.value,
        deadline: expiry,
        signal: AbortSignal.any([context.signal, controller.signal]),
      };
      const stop = () => revoke(grant.id);
      const clear = scheduleDeadline(Date.parse(expiry), stop);
      context.signal.addEventListener('abort', stop, { once: true });
      grants.set(grant.id, {
        grant,
        context: caller,
        credential: crypto.randomUUID() + crypto.randomUUID(),
        controller,
        receipts: new Map(),
        release() {
          clear();
          context.signal.removeEventListener('abort', stop);
        },
      });
      if (context.signal.aborted) {
        revoke(grant.id);
        return fail('bridge.cancelled', 'Owner cancelled', 'cancelled');
      }
      return ok(grant);
    },
    authenticate(id, credential, audience) {
      const entry = live(id);
      return entry &&
        entry.grant.enforcement === 'authenticated-channel' &&
        entry.credential === credential &&
        entry.grant.audience === audience
        ? ok(entry.context)
        : fail('bridge.authentication', 'Bridge authentication failed', 'permission');
    },
    grant(id, context) {
      const entry = live(id);
      return entry && same(entry.context, context)
        ? ok(entry.grant)
        : fail('bridge.permission', 'Grant access denied', 'permission');
    },
    credential(id, context) {
      const entry = live(id);
      return entry &&
        same(entry.context, context) &&
        entry.grant.enforcement === 'authenticated-channel'
        ? ok(entry.credential)
        : fail('bridge.permission', 'Credential access denied', 'permission');
    },
    async invoke(request, context) {
      if (
        !isJsonObject(request) ||
        Object.keys(request).some((k) => !['id', 'grantId', 'method', 'params'].includes(k)) ||
        typeof request.id !== 'string' ||
        !request.id ||
        typeof request.grantId !== 'string' ||
        typeof request.method !== 'string' ||
        !isJson(request.params)
      )
        return denied('', 'bridge.request', 'Invalid bridge request');
      const entry = live(request.grantId);
      if (
        !entry ||
        !same(entry.context, context) ||
        (entry.grant.enforcement === 'authenticated-channel' && context !== entry.context) ||
        !entry.grant.allowedMethods.includes(request.method)
      )
        return denied(request.id, 'bridge.permission', 'Grant does not permit this call');
      const method = registry[request.method]!;
      if (
        method.profileRequired &&
        (!isJsonObject(request.params) ||
          typeof request.params.profileId !== 'string' ||
          !entry.grant.allowedProfiles.includes(request.params.profileId))
      )
        return denied(request.id, 'bridge.profile', 'Profile is outside the grant');
      const fingerprint = canonical({ method: request.method, params: request.params });
      const existing = entry.receipts.get(request.id);
      if (existing)
        return existing.fingerprint === fingerprint
          ? existing.result
          : denied(request.id, 'bridge.dedupe', 'Request ID has different content');
      if (entry.receipts.size >= capacity)
        return denied(request.id, 'bridge.capacity', 'Receipt capacity reached');
      const fixed = freeze(structuredClone(request.params));
      const result = Promise.resolve().then(async () => {
        if (entry.context.signal.aborted)
          return denied(request.id, 'bridge.cancelled', 'Grant is no longer active');
        try {
          const receipt = await method.invoke(fixed, entry.context);
          return { ...receipt, commandId: request.id };
        } catch {
          return {
            kind: 'failed' as const,
            commandId: request.id,
            effect: 'unknown' as const,
            commit: [],
            error: fail('bridge.method', 'Bridge method failed', 'internal', 'unknown').error,
          };
        }
      });
      entry.receipts.set(request.id, { fingerprint, result });
      return result;
    },
    async revoke(id, context) {
      const entry = grants.get(id);
      if (entry && !same(entry.context, context))
        return fail('bridge.permission', 'Grant revocation denied', 'permission');
      revoke(id);
      return ok(undefined);
    },
    close() {
      closed = true;
      for (const id of grants.keys()) revoke(id);
    },
  };
}
