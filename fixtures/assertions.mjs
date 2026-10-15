// @ts-check
import assert from 'node:assert/strict';

/** Read a property only from the union variants that carry it.
 * @template T
 * @template {PropertyKey} K
 * @param {T} value
 * @param {K} key
 * @returns {T extends Record<K, infer V> ? V : never}
 */
export function expectProperty(value, key) {
  assert.ok(
    value !== null && (typeof value === 'object' || typeof value === 'function') && key in value,
    `Expected property ${String(key)}`,
  );
  return Reflect.get(Object(value), key);
}

/** Validate structural records at the JSON serialization boundary.
 * @template T
 * @param {T} value
 * @returns {T & import('@slop-lab/part/reference/index.js').Contracts.Json}
 */
export function json(value) {
  const decoded = JSON.parse(JSON.stringify(value));
  assert.deepEqual(decoded, value, 'Expected lossless JSON data');
  return /** @type {T & import('@slop-lab/part/reference/index.js').Contracts.Json} */ (decoded);
}

/** A partial test double; omitted methods must not be called by the test.
 * @template T
 * @param {object} value
 * @returns {T}
 */
export function stub(value) {
  return /** @type {T} */ (/** @type {unknown} */ (value));
}
