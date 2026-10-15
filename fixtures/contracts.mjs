// @ts-check
import assert from 'node:assert/strict';
import { fail, isJson, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';

/** A service binding preserves the key's value type at registration.
 * @template T
 * @param {import('@slop-lab/part/reference/index.js').Contracts.ServiceKey<T>} key
 * @param {T} value
 * @returns {import('@slop-lab/part/reference/index.js').Contracts.ServiceAccess}
 */
export function singleService(key, value) {
  return {
    /** @template U
     * @param {import('@slop-lab/part/reference/index.js').Contracts.ServiceKey<U>} requested
     * @returns {import('@slop-lab/part/reference/index.js').Contracts.Result<U>}
     */
    get(requested) {
      if (!Object.is(requested, key)) return fail('service.missing', 'Missing test service');
      // The same key object identifies the binding; generic type parameters are erased at runtime.
      return ok(/** @type {U} */ (/** @type {unknown} */ (value)));
    },
  };
}

/** @param {string} text @returns {import('@slop-lab/part/reference/index.js').Contracts.Json} */
export function parseJSON(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  assert.ok(isJson(value), 'Expected JSON data');
  return value;
}

/** @param {string} text @returns {Record<string, import('@slop-lab/part/reference/index.js').Contracts.Json>} */
export function parseObject(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  assert.ok(isJsonObject(value), 'Expected a JSON object');
  return value;
}
