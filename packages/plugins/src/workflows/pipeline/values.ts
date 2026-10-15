import { fail, isJson, isJsonObject, ok } from '@slop-lab/part/contracts';
import type { Contracts, PipelineV1 } from '@slop-lab/part/reference';
export const objectValid = (value: unknown): boolean => isJsonObject(value);
export const jsonValid = (value: unknown): boolean => isJson(value);
export function pointer(value: Contracts.Json, path: string): Contracts.Result<Contracts.Json> {
  if (!path) return ok(value);
  if (!path.startsWith('/') || /~(?![01])/u.test(path))
    return fail('pipeline.pointer', 'Invalid JSON Pointer');
  let current = value;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key) ||
      (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key))
    )
      return fail('pipeline.pointer', `JSON Pointer target missing: ${path}`);
    current = (current as Record<string, Contracts.Json>)[key]!;
  }
  return ok(current);
}
export function valueValid(value: unknown): value is PipelineV1.Value {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return (
    (keys.length === 1 &&
      ('literal' in value ||
        (typeof value.input === 'string' &&
          (value.input === '' ||
            (value.input.startsWith('/') && !/~(?![01])/u.test(value.input)))))) ||
    (keys.length === 2 &&
      typeof value.step === 'string' &&
      typeof value.pointer === 'string' &&
      (value.pointer === '' ||
        (value.pointer.startsWith('/') && !/~(?![01])/u.test(value.pointer))))
  );
}
