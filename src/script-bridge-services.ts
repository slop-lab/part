import type { Contracts, Model, Runtime, Results, Composition } from './reference.js';
import type { BridgeMethod } from './script-bridge.js';
import { isJsonObject, fail, canonical } from './contracts.js';
/** Installed profile bindings contain executable/composition values only on the host. */
export function createBridgeMethods(options: {
  model?: Model.Gateway;
  runs?: Runtime.RunService;
  runProfiles?: Readonly<
    Record<string, { driver: string; composition: Composition.CompositionHandle }>
  >;
  results?: Results.Service;
  waits?: Runtime.SuspensionPort;
  authorizeWait?: (
    ticket: Runtime.WaitTicket,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<void>>;
}): Readonly<Record<string, BridgeMethod>> {
  const handles = new Map<
    string,
    { handle: Runtime.ExecutionHandle<unknown>; principal: string; scope: string }
  >();
  const profiles = { ...options.runProfiles };
  const methods: Record<string, BridgeMethod> = {};
  const reject = (message: string): Contracts.CommandReceipt => ({
    kind: 'rejected',
    commandId: '',
    error: fail('bridge.params', message).error,
  });
  const completed = (result: Contracts.Json): Contracts.CommandReceipt => ({
    kind: 'completed',
    commandId: '',
    result,
    effect: 'not-applicable',
    commit: [],
  });
  const remember = (
    handle: Runtime.ExecutionHandle<unknown>,
    context: Contracts.InvocationContext,
  ): Contracts.CommandReceipt => {
    handles.set(handle.ref.id, {
      handle,
      principal: canonical(context.principal),
      scope: context.scope.id,
    });
    return { kind: 'accepted', commandId: '', operation: handle.ref, commit: [] };
  };
  const lookup = (params: Contracts.Json, context: Contracts.InvocationContext) => {
    if (!isJsonObject(params) || typeof params.id !== 'string') return undefined;
    const record = handles.get(params.id);
    return record?.principal === canonical(context.principal) && record.scope === context.scope.id
      ? record.handle
      : undefined;
  };
  if (options.model)
    methods['model.invoke'] = {
      profileRequired: true,
      async invoke(params, context) {
        if (
          !isJsonObject(params) ||
          typeof params.profileId !== 'string' ||
          !isJsonObject(params.invocation)
        )
          return reject('Expected profileId and invocation');
        const invocation = {
          ...params.invocation,
          profileId: params.profileId,
        } as unknown as Model.Invocation;
        const started = await options.model!.invoke(invocation, context);
        return started.ok
          ? remember(started.value, context)
          : { kind: 'rejected', commandId: '', error: started.error };
      },
    };
  if (options.runs)
    methods['run.start'] = {
      profileRequired: true,
      async invoke(params, context) {
        if (
          !isJsonObject(params) ||
          typeof params.profileId !== 'string' ||
          !Object.hasOwn(profiles, params.profileId) ||
          !Object.hasOwn(params, 'input')
        )
          return reject('Expected an installed run profile and input');
        const profile = profiles[params.profileId]!;
        const started = await options.runs!.start({ ...profile, input: params.input! }, context);
        return started.ok
          ? remember(started.value, context)
          : { kind: 'rejected', commandId: '', error: started.error };
      },
    };
  methods['run.get'] = {
    async invoke(params, context) {
      const handle = lookup(params, context);
      if (!handle) return reject('Execution is outside the grant owner');
      const snapshot = handle.snapshot();
      if (['completed', 'failed', 'cancelled', 'abandoned'].includes(snapshot.phase))
        return completed({
          snapshot: snapshot as unknown as Contracts.Json,
          outcome: (await handle.done) as unknown as Contracts.Json,
        });
      return completed({ snapshot: snapshot as unknown as Contracts.Json });
    },
  };
  methods['run.cancel'] = {
    async invoke(params, context) {
      const handle = lookup(params, context);
      if (!handle) return reject('Execution is outside the grant owner');
      const result = await handle.requestCancel('script-bridge');
      return result.ok
        ? completed(result.value as unknown as Contracts.Json)
        : { kind: 'rejected', commandId: '', error: result.error };
    },
  };
  if (options.results)
    methods['result.submit'] = {
      async invoke(params, context) {
        if (
          !isJsonObject(params) ||
          !isJsonObject(params.producedBy) ||
          params.producedBy.id !== context.scope.id
        )
          return reject('Result producer must be the grant owner');
        const accepted = await options.results!.submit(
          params as unknown as Results.Submission,
          context,
        );
        return accepted.ok
          ? completed(accepted.value as unknown as Contracts.Json)
          : { kind: 'rejected', commandId: '', error: accepted.error };
      },
    };
  if (options.waits && options.authorizeWait)
    methods['wait.respond'] = {
      async invoke(params, context) {
        if (
          !isJsonObject(params) ||
          !isJsonObject(params.ticket) ||
          typeof params.commandId !== 'string'
        )
          return reject('Expected a response envelope');
        const ticket = params.ticket as unknown as Runtime.WaitTicket;
        const allowed = await options.authorizeWait!(ticket, context);
        if (!allowed.ok) return { kind: 'rejected', commandId: '', error: allowed.error };
        const responded = await options.waits!.respond(
          ticket,
          params.response,
          params.commandId,
          context,
        );
        return responded.ok
          ? completed(responded.value as unknown as Contracts.Json)
          : { kind: 'rejected', commandId: '', error: responded.error };
      },
    };
  return methods;
}
