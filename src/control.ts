import type { Contracts, Control, Client } from './reference.js';
import { ok, fail, schema, isJsonObject, isJson, canonical } from './contracts.js';

const fields = (value: Record<string, Contracts.Json>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const entityValid = (value: unknown): value is Contracts.EntityRef =>
  isJsonObject(value) &&
  fields(value, ['owner', 'kind', 'id']) &&
  typeof value.owner === 'string' &&
  typeof value.kind === 'string' &&
  typeof value.id === 'string';
const preconditionsValid = (value: unknown): boolean =>
  isJsonObject(value) &&
  fields(value, ['versions']) &&
  Array.isArray(value.versions) &&
  value.versions.every(
    (v) =>
      isJsonObject(v) &&
      fields(v, ['ref', 'expected']) &&
      entityValid(v.ref) &&
      typeof v.expected === 'string',
  );
export const commandSchema = schema<Contracts.CommandRequest>(
  'part/command',
  (value): value is Contracts.CommandRequest =>
    isJsonObject(value) &&
    fields(value, [
      'protocolVersion',
      'commandId',
      'actionId',
      'actionVersion',
      'target',
      'input',
      'preconditions',
      'idempotencyKey',
    ]) &&
    value.protocolVersion === 1 &&
    typeof value.commandId === 'string' &&
    !!value.commandId &&
    typeof value.actionId === 'string' &&
    !!value.actionId &&
    typeof value.actionVersion === 'number' &&
    Number.isSafeInteger(value.actionVersion) &&
    value.actionVersion >= 1 &&
    isJson(value.input) &&
    (value.target === undefined || entityValid(value.target)) &&
    (value.preconditions === undefined || preconditionsValid(value.preconditions)) &&
    (value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string'),
);
export const querySchema = schema<Contracts.QueryRequest>(
  'part/query',
  (value): value is Contracts.QueryRequest =>
    isJsonObject(value) &&
    fields(value, ['queryId', 'version', 'input', 'target']) &&
    typeof value.queryId === 'string' &&
    typeof value.version === 'number' &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    isJson(value.input) &&
    (value.target === undefined || entityValid(value.target)),
);
export interface InstalledAction {
  readonly id: string;
  readonly binding: unknown;
}
export interface InstalledQuery {
  readonly id: string;
  readonly binding: unknown;
}
const actions = new WeakMap<object, Control.ActionBinding<unknown, unknown>>(),
  queries = new WeakMap<object, Client.QueryBinding<unknown, unknown>>();
export function installAction<I, O>(binding: Control.ActionBinding<I, O>): InstalledAction {
  const token = {};
  actions.set(token, {
    ...binding,
    input: binding.input as Contracts.Schema<unknown>,
    output: binding.output as Contracts.Schema<unknown>,
    async execute(request, context) {
      const checked = binding.input.validate(request.input);
      if (!checked.ok)
        return {
          kind: 'rejected',
          commandId: request.commandId,
          error: fail('action.input', 'Input validation failed').error,
        } as Contracts.CommandReceipt;
      return binding.execute({ ...request, input: checked.value }, context);
    },
  });
  return Object.freeze({ id: binding.id, binding: token });
}
export function installQuery<I, O>(binding: Client.QueryBinding<I, O>): InstalledQuery {
  const token = {};
  queries.set(token, {
    ...binding,
    input: binding.input as Contracts.Schema<unknown>,
    output: binding.output as Contracts.Schema<unknown>,
    async read(input, context) {
      const checked = binding.input.validate(input);
      return checked.ok
        ? binding.read(checked.value, context)
        : fail('query.input', 'Input validation failed');
    },
  });
  return Object.freeze({ id: binding.id, binding: token });
}
export function createControl(
  options: {
    actions?: readonly InstalledAction[];
    queries?: readonly InstalledQuery[];
    dedupeLimit?: number;
  } = {},
): Contracts.Result<
  Control.ActionGateway & {
    query(
      request: Contracts.QueryRequest,
      context: Contracts.InvocationContext,
    ): Promise<Contracts.Result<Contracts.Json>>;
  }
> {
  const actionMap = new Map<string, Control.ActionBinding<unknown, unknown>>(),
    queryMap = new Map<string, Client.QueryBinding<unknown, unknown>>();
  for (const installed of options.actions ?? []) {
    const binding =
      installed.binding && typeof installed.binding === 'object'
        ? actions.get(installed.binding)
        : undefined;
    if (!binding || binding.id !== installed.id || actionMap.has(installed.id))
      return fail('action.registration', 'Invalid or duplicate action');
    actionMap.set(installed.id, binding);
  }
  for (const installed of options.queries ?? []) {
    const binding =
      installed.binding && typeof installed.binding === 'object'
        ? queries.get(installed.binding)
        : undefined;
    if (!binding || binding.id !== installed.id || queryMap.has(installed.id))
      return fail('query.registration', 'Invalid or duplicate query');
    queryMap.set(installed.id, binding);
  }
  const receipts = new Map<
    string,
    { digest: string; result: Promise<Contracts.CommandReceipt>; settled: boolean }
  >();
  return ok({
    async describe(target, context) {
      const results = await Promise.all(
        [...actionMap.values()].map((action) => action.describe(target, context)),
      );
      const error = results.find((result) => !result.ok);
      if (error && !error.ok) return error;
      return ok(results.flatMap((r) => (r.ok ? [r.value] : [])));
    },
    async invoke(request, context) {
      const commandId = typeof request?.commandId === 'string' ? request.commandId : 'invalid';
      const rejected = (error: Contracts.Failure): Contracts.CommandReceipt => ({
        kind: 'rejected',
        commandId,
        error,
      });
      if (!commandSchema.validate(request).ok)
        return rejected({
          code: 'part.command.invalid',
          category: 'validation',
          message: 'Invalid command envelope',
          retry: 'never',
        });
      const binding = actionMap.get(request.actionId);
      if (!binding || binding.version !== request.actionVersion)
        return rejected({
          code: 'part.action.unsupported',
          category: 'unsupported',
          message: 'Action or version is not installed',
          retry: 'never',
        });
      if (context.signal.aborted)
        return rejected({
          code: 'part.command.cancelled',
          category: 'cancelled',
          message: 'Command not admitted',
          retry: 'never',
        });
      const input = binding.input.validate(request.input);
      if (!input.ok)
        return rejected({
          code: 'part.action.input',
          category: 'validation',
          message: 'Input validation failed',
          retry: 'never',
        });
      const descriptor = await binding.describe(request.target, context);
      if (!descriptor.ok) return rejected(descriptor.error);
      if (descriptor.value.availability.state !== 'available')
        return rejected({
          code: 'part.action.disabled',
          category: 'permission',
          message: descriptor.value.availability.reason ?? 'Action unavailable',
          retry: 'never',
        });
      const key = canonical({
        principal: context.principal,
        key: request.idempotencyKey ?? request.commandId,
      });
      const normalized = {
          ...request,
          ...(request.idempotencyKey ? { commandId: 'deduplicated' } : {}),
        },
        requestDigest = canonical(normalized as unknown as Contracts.Json);
      const cached = receipts.get(key);
      if (cached)
        return cached.digest === requestDigest
          ? { ...(await cached.result), commandId }
          : rejected({
              code: 'part.command.key-conflict',
              category: 'conflict',
              message: 'Command key has different content',
              retry: 'never',
            });
      if (receipts.size >= (options.dedupeLimit ?? 1000))
        return rejected({
          code: 'part.command.dedupe-capacity',
          category: 'unavailable',
          message: 'Command dedupe capacity exhausted; create a new control scope',
          retry: 'never',
        });
      let resolve!: (receipt: Contracts.CommandReceipt) => void;
      const result = new Promise<Contracts.CommandReceipt>((r) => {
        resolve = r;
      });
      const entry = { digest: requestDigest, result, settled: false };
      receipts.set(key, entry);
      let receipt: Contracts.CommandReceipt;
      try {
        const executed = await binding.execute({ ...request, input: input.value }, context);
        if (executed.kind === 'completed') {
          const output = binding.output.validate(executed.result);
          receipt =
            output.ok && isJson(output.value)
              ? { ...executed, result: output.value }
              : {
                  kind: 'failed',
                  commandId,
                  error: {
                    code: 'part.action.output',
                    category: 'validation',
                    message: 'Action output validation failed',
                    retry: 'never',
                  },
                  effect: executed.effect,
                  commit: executed.commit,
                };
        } else receipt = executed as Contracts.CommandReceipt;
        if (!isJson(receipt))
          receipt = {
            kind: 'failed',
            commandId,
            error: {
              code: 'part.action.receipt',
              category: 'internal',
              message: 'Receipt is not wire-safe',
              retry: 'after-reconciliation',
            },
            effect: 'unknown',
            commit: [],
          };
      } catch {
        receipt = {
          kind: 'failed',
          commandId,
          error: {
            code: 'part.action.exception',
            category: 'internal',
            message: 'Action failed',
            retry: 'after-reconciliation',
          },
          effect: 'unknown',
          commit: [],
        };
      }
      entry.settled = true;
      receipt = structuredClone(receipt);
      resolve(receipt);
      return structuredClone(receipt);
    },
    async query(request, context) {
      if (!querySchema.validate(request).ok)
        return fail('query.envelope', 'Invalid query envelope');
      const binding = queryMap.get(request.queryId);
      if (!binding || binding.version !== request.version)
        return fail('query.unsupported', 'Query or version is not installed', 'unsupported');
      const input = binding.input.validate(request.input);
      if (!input.ok) return fail('query.input', 'Input validation failed');
      try {
        const result = await binding.read(input.value, context);
        if (!result.ok) return result;
        const output = binding.output.validate(result.value);
        return output.ok && isJson(output.value)
          ? ok(structuredClone(output.value))
          : fail('query.output', 'Query output is not wire-safe');
      } catch {
        return fail('query.exception', 'Query failed', 'internal');
      }
    },
  });
}
