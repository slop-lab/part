// @ts-check
import assert from 'node:assert/strict';

/** Require a value before inspecting it, including array lookups and optional ports.
 * @template T
 * @param {T} value
 * @returns {NonNullable<T>}
 */
export function present(value) {
  assert.ok(value !== null && value !== undefined, 'Expected a present value');
  return value;
}

/** @template [T=void] @returns {PromiseWithResolvers<T>} */
export function deferred() {
  return Promise.withResolvers();
}

/** Read a property only from the union variants that carry it.
 * @template T
 * @template {PropertyKey} K
 * @param {T} value
 * @param {K} key
 * @returns {unknown extends T ? unknown : T extends unknown ? K extends keyof T ? T[K] : never : never}
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
  /** @type {unknown} */
  const decoded = JSON.parse(JSON.stringify(value));
  assert.deepEqual(decoded, value, 'Expected lossless JSON data');
  return /** @type {T & import('@slop-lab/part/reference/index.js').Contracts.Json} */ (decoded);
}

/** A partial test double; omitted methods must not be called by the test.
 * @template T
 * @param {Partial<NoInfer<T>>} value
 * @returns {T}
 */
export function stub(value) {
  return /** @type {T} */ (/** @type {unknown} */ (value));
}
