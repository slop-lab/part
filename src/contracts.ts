import type { Contracts as C } from './reference.js';
export type * from './reference.js';
export const ok = <T>(value: T): C.Result<T> => ({ ok: true, value });
export function fail(code: string, message: string, category: C.Failure['category'] = 'validation', effect?: C.EffectState): { readonly ok: false; readonly error: C.Failure } {
  return { ok: false, error: { code: `part.${code}`, message, category, retry: 'never', ...(effect ? { effect } : {}) } };
}
export const emptyCleanup = (): C.CleanupReport => ({ released: [], unresolved: [], errors: [] });
export function isJson(value: unknown, seen = new Set<object>()): value is C.Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  const valid = keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    if (Array.isArray(value) && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.enumerable && 'value' in descriptor && isJson(descriptor.value, seen);
  }) && (!Array.isArray(value) || Object.keys(value).length === value.length);
  seen.delete(value);
  return valid;
}
export function isJsonObject(value: unknown): value is { readonly [key: string]: C.Json } { return isJson(value) && value !== null && typeof value === 'object' && !Array.isArray(value); }
export function schema<T>(id: string, validate: (value: unknown) => value is T, version = 1): C.Schema<T> {
  const ref = { id, version };
  const check: C.Schema<T>['validate'] = input => {
    try { return validate(input) ? { ok: true, value: input } : { ok: false, error: [{ path: [], code: 'invalid', message: `Invalid ${id}` }] }; }
    catch { return { ok: false, error: [{ path: [], code: 'invalid', message: `Invalid ${id}` }] }; }
  };
  return { ref, validate: check, codec: {
    schema: ref,
    encode(value) { const result = check(value); return result.ok && isJson(value) ? ok(structuredClone(value)) : fail('codec.invalid', `Cannot encode ${id}`); },
    decode(value) { const result = check(value); return result.ok && isJson(value) ? ok(structuredClone(result.value)) : fail('codec.invalid', `Cannot decode ${id}`); },
  } };
}
export const jsonSchema = schema<C.Json>('part/json', isJson);
export const stringSchema = schema<string>('part/string', (value): value is string => typeof value === 'string');
export function canonical(value: C.Json): string {
  if (!isJson(value)) throw new TypeError('Expected lossless JSON');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, C.Json>)[key]!)}`).join(',')}}`;
}
export async function digest(value: C.Json | Uint8Array): Promise<string> {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function localContext(options: Partial<C.InvocationContext> = {}): C.InvocationContext {
  return { principal: { subject: 'local', authority: 'part/embedding' }, scope: { kind: 'runtime', id: crypto.randomUUID() },
    services: { get: key => fail('service.missing', `Missing service ${key.id}`, 'unsupported') },
    signal: new AbortController().signal, correlationId: crypto.randomUUID(), ...options };
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
