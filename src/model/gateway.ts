import { digest, fail, freeze, ok } from '../foundation/contracts.js';
import type { Contracts, Model, Runtime } from '../reference/index.js';
import type { CostEstimator } from '../runtime/costs.js';
import { costPolicyKey, costUnits } from '../runtime/costs.js';
import type { Operations } from '../runtime/index.js';
import { budgetKey, createBoundary, createOperations, managedAttempt } from '../runtime/index.js';
export { budgetKey } from '../runtime/index.js';
export function reserve(
  context: Contracts.InvocationContext,
  dimension: string,
  quantity = 1,
): Contracts.Result<Runtime.BudgetReservation | undefined> {
  const budget = context.services.get(budgetKey);
  return budget.ok ? budget.value.reserve(dimension, quantity) : ok(undefined);
}
export function createModelGateway(options: {
  profiles: readonly Model.Profile[];
  adapters: readonly Model.Adapter[];
  transports: readonly Model.Transport[];
  auth: Readonly<Record<string, Model.AuthStrategy>>;
  operations?: Operations;
  boundary?: Runtime.InvocationBoundary;
  transforms?: readonly Model.RequestTransform[];
  validateRequest?: (
    request: Model.EncodedRequest,
    profile: Model.Profile,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<void>>;
  inspect?: (inspection: Model.RequestInspection) => void;
  maxResponseBytes?: number;
  compositionRevision?: string;
  costEstimator?: CostEstimator;
}): Contracts.Result<Model.Gateway> {
  const profiles = new Map(options.profiles.map((p) => [p.id, freeze(structuredClone(p))])),
    adapters = new Map(options.adapters.map((a) => [a.id, a])),
    transports = new Map(options.transports.map((t) => [t.id, t]));
  if (
    profiles.size !== options.profiles.length ||
    adapters.size !== options.adapters.length ||
    transports.size !== options.transports.length
  )
    return fail('model.duplicate', 'Duplicate profile, adapter, or transport');
  for (const profile of profiles.values())
    if (
      !adapters.has(profile.adapterId) ||
      !transports.has(profile.transportId) ||
      !options.auth[profile.authStrategyId]
    )
      return fail('model.dependency', `Unresolved profile ${profile.id}`, 'unsupported');
  const operations = options.operations ?? createOperations(),
    boundary = options.boundary ?? createBoundary(),
    transforms = [...(options.transforms ?? [])];
  return ok({
    async invoke(request, context) {
      const profile = profiles.get(request.profileId);
      if (!profile) return fail('model.profile', request.profileId, 'unsupported');
      const adapter = adapters.get(profile.adapterId)!,
        transport = transports.get(profile.transportId)!;
      if (
        request.continuation &&
        (request.continuation.provider !== adapter.id ||
          (request.continuation.affinity?.profile &&
            request.continuation.affinity.profile !== profile.id))
      )
        return fail(
          'model.affinity',
          'Native continuation is incompatible with this profile',
          'unsupported',
        );
      if (
        request.tools.some((t) => t.execution === 'provider') &&
        !profile.capabilities.entries.some(
          (c) => c.id === 'part/provider-hosted-tools' && c.status === 'supported',
        )
      )
        return fail(
          'model.hosted-tool',
          'Hosted tools are not enabled by this profile',
          'unsupported',
        );
      const fixed = freeze(structuredClone(request));
      return operations.begin<Model.Response>(
        { kind: 'part/model', retryOwner: 'part/model', childPolicy: 'attached' },
        async (c) => {
          const error = (failure: Contracts.Failure): Runtime.ManagedOutcome<Model.Response> => ({
            phase: 'failed',
            error: failure,
            effect: 'not-attempted',
            commit: [],
            unsettledChildren: [],
          });
          const invocationBudget = reserve(c, 'maxModelInvocations');
          if (!invocationBudget.ok) return error(invocationBudget.error);
          let encoded = await adapter.encode(fixed, profile);
          if (!encoded.ok) return error(encoded.error);
          for (const transform of transforms) {
            encoded = await transform.apply(encoded.value, c);
            if (!encoded.ok) return error(encoded.error);
          }
          const finalRequest = {
            ...encoded.value,
            body: Uint8Array.from(encoded.value.body),
            digest: await digest(encoded.value.body),
          };
          const checked = await options.validateRequest?.(finalRequest, profile, c);
          if (checked && !checked.ok) return error(checked.error);
          const auth = await options.auth[profile.authStrategyId]!.bind(profile, c);
          if (!auth.ok) return error(auth.error);
          const attemptId = crypto.randomUUID();
          options.inspect?.({
            requestId: crypto.randomUUID(),
            contextId: fixed.context.id,
            attemptId,
            actualDigest: finalRequest.digest,
            boundary: finalRequest.inspectionBoundary,
            redactions: ['body', 'credentials'],
            transportId: transport.id,
          });
          const effectPlan: Runtime.EffectPlan = {
            operationId: c.scope.id,
            attemptId,
            target: profile.id,
            executor: transport.id,
            inputDigest: finalRequest.digest,
            scopeDigest: await digest({ principal: c.principal, scope: { ...c.scope } }),
            compositionRevision:
              (c as Contracts.InvocationContext & { compositionRevision?: string })
                .compositionRevision ??
              options.compositionRevision ??
              'memory',
            classification: 'external',
          };
          return managedAttempt<Model.Response>(
            boundary,
            effectPlan,
            async () => {
              const attempts = reserve(c, 'maxExecutorAttempts');
              if (!attempts.ok)
                return { kind: 'failed', error: attempts.error, effect: 'not-attempted' };
              const costPolicy = c.services.get(costPolicyKey);
              if (costPolicy.ok) {
                if (!options.costEstimator)
                  return {
                    kind: 'failed',
                    error: fail(
                      'model.cost-estimator',
                      'A configured cost estimator is required by this budget',
                      'unsupported',
                    ).error,
                    effect: 'not-attempted',
                  };
                const estimate = await options.costEstimator.estimate(fixed, profile, c);
                if (!estimate.ok)
                  return { kind: 'failed', error: estimate.error, effect: 'not-attempted' };
                const units = costUnits(estimate.value.amount);
                if (!units.ok || estimate.value.currency !== costPolicy.value.currency)
                  return {
                    kind: 'failed',
                    error: fail(
                      'model.cost-currency',
                      'Cost estimate does not match the budget currency',
                    ).error,
                    effect: 'not-attempted',
                  };
                const reserved = reserve(
                  c,
                  'estimatedCost/' + estimate.value.currency,
                  units.value,
                );
                if (!reserved.ok)
                  return { kind: 'failed', error: reserved.error, effect: 'not-attempted' };
                c.progress.publish('part.model/cost-estimate', {
                  estimator: options.costEstimator.id,
                  version: options.costEstimator.version,
                  amount: estimate.value.amount,
                  currency: estimate.value.currency,
                  basis: 'estimate',
                });
              }
              if (c.signal.aborted) return { kind: 'cancelled', effect: 'not-attempted' };
              const sent = await transport.send(finalRequest, profile, auth.value, c);
              if (!sent.ok)
                return {
                  kind: 'failed',
                  error: sent.error,
                  effect: sent.error.effect ?? 'unknown',
                };
              const decoder = adapter.createDecoder(sent.value);
              if (!decoder.ok) return { kind: 'failed', error: decoder.error, effect: 'applied' };
              let bytes = 0;
              for await (const chunk of sent.value.body) {
                if (c.signal.aborted) return { kind: 'cancelled', effect: 'unknown' };
                bytes += chunk.byteLength;
                if (bytes > (options.maxResponseBytes ?? 8 * 1024 * 1024))
                  return {
                    kind: 'failed',
                    error: {
                      code: 'part.model.response-limit',
                      category: 'validation',
                      message: 'Response exceeded byte limit',
                      retry: 'never',
                    },
                    effect: 'applied',
                  };
                const pushed = decoder.value.push(chunk);
                if (!pushed.ok) return { kind: 'failed', error: pushed.error, effect: 'applied' };
                for (const event of pushed.value) c.progress.publish(event.type, event.payload);
              }
              const response = decoder.value.finish();
              if (!response.ok) return { kind: 'failed', error: response.error, effect: 'applied' };
              const known =
                (response.value.usage.inputTokens ?? 0) + (response.value.usage.outputTokens ?? 0);
              const tokens = reserve(c, 'maxKnownTokens', known);
              if (!tokens.ok) return { kind: 'failed', error: tokens.error, effect: 'applied' };
              return { kind: 'returned', value: response.value, effect: 'applied' };
            },
            c,
          );
        },
        context,
      );
    },
  });
}
export const noAuth: Model.AuthStrategy = {
  async bind() {
    return ok({ strategy: 'none', material: undefined });
  },
};
/** Credential lookup is explicitly provided by the host; no process-global environment lookup. */
export function bearerAuth(credential: () => Promise<string> | string): Model.AuthStrategy {
  return {
    async bind() {
      try {
        const token = await credential();
        return typeof token === 'string' && token.length
          ? ok({ strategy: 'bearer', material: token })
          : fail('auth.empty', 'Empty credential', 'permission');
      } catch {
        return fail('auth.unavailable', 'Credential unavailable', 'permission');
      }
    },
  };
}
export function createFetchTransport(
  options: { fetch?: typeof fetch; allowedOrigins?: readonly string[] } = {},
): Model.Transport {
  return {
    id: 'part/fetch',
    async send(request, profile, auth, context) {
      if (!profile.endpoint) return fail('transport.endpoint', 'Endpoint required');
      let url: URL;
      try {
        url = new URL(profile.endpoint);
      } catch {
        return fail('transport.endpoint', 'Invalid endpoint');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        (options.allowedOrigins && !options.allowedOrigins.includes(url.origin))
      )
        return fail('transport.endpoint', 'Endpoint is not allowed', 'permission');
      if (auth.strategy !== 'none' && auth.strategy !== 'bearer')
        return fail('transport.auth', 'Unsupported credential binding', 'unsupported');
      if (context.signal.aborted)
        return fail('transport.cancelled', 'Not sent', 'cancelled', 'not-attempted');
      try {
        const headers: Record<string, string> = { 'content-type': request.mediaType };
        if (auth.strategy === 'bearer') {
          if (typeof auth.material !== 'string')
            return fail('transport.auth', 'Invalid credential binding');
          headers.authorization = `Bearer ${auth.material}`;
        }
        const response = await (options.fetch ?? fetch)(url, {
          method: 'POST',
          headers,
          body: Uint8Array.from(request.body),
          signal: context.signal,
          redirect: 'error',
        });
        const responseHeaders = Object.fromEntries(response.headers.entries());
        return ok({
          status: response.status,
          headers: responseHeaders,
          body: (async function* () {
            if (!response.body) return;
            const reader = response.body.getReader();
            let done = false;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                  done = true;
                  return;
                }
                yield chunk.value;
              }
            } finally {
              if (!done) await reader.cancel();
              reader.releaseLock();
            }
          })(),
        });
      } catch {
        return fail(
          'transport.delivery',
          'Transport did not return a response',
          context.signal.aborted ? 'cancelled' : 'unavailable',
          'unknown',
        );
      }
    },
  };
}
