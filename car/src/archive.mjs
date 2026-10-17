// @ts-check
import { isJson, isJsonObject, localContext, ok, fail } from '@slop-lab/part/contracts/index.js';
import { provenance } from '@slop-lab/part/context/index.js';

/** @import { Contracts } from '@slop-lab/part/reference/index.js' */
/** @typedef {import('@slop-lab/part/reference/index.js').Storage.StateJournalStore} Store */

/** A projection archive, never a competing run/workflow scheduler.
 * @param {Store} store
 * @param {Contracts.InvocationContext} context
 */
export function createArchive(store, context = localContext()) {
  const scope = { kind: 'application', id: 'car' };
  /** @type {Promise<void>} */
  let writing = Promise.resolve();
  /** @type {Contracts.Failure | undefined} */
  let error;
  /** @param {string} type @param {unknown} value */
  function record(type, value) {
    if (!isJson(value)) throw new TypeError('Archive values must be lossless JSON');
    const fixed = structuredClone(value);
    writing = writing.then(async () => {
      if (error) return;
      const result = await store.commit(
        {
          id: crypto.randomUUID(),
          mutations: [],
          append: [
            {
              id: crypto.randomUUID(),
              type: `car/${type}`,
              version: 1,
              payload: { principal: { ...context.principal }, data: fixed },
              provenance,
            },
          ],
        },
        context,
      );
      if (!result.ok) error = result.error;
    });
  }
  return {
    record,
    async flush() {
      await writing;
      return error ? { ok: false, error } : ok(undefined);
    },
    /** @param {string} type @param {Contracts.InvocationContext} caller */
    async read(type, caller) {
      if (
        caller.principal.subject !== context.principal.subject ||
        caller.principal.authority !== context.principal.authority
      )
        return fail('car.permission', 'Archive access denied', 'permission');
      await writing;
      /** @type {Contracts.Json[]} */
      const values = [];
      /** @type {string | undefined} */
      let cursor;
      do {
        const page = await store.journal(cursor, 1000, caller);
        if (!page.ok) return page;
        for (const entry of page.value.items) {
          if (entry.type !== `car/${type}` || !isJsonObject(entry.payload)) continue;
          const principal = entry.payload.principal;
          if (
            isJsonObject(principal) &&
            principal.subject === caller.principal.subject &&
            principal.authority === caller.principal.authority &&
            entry.payload.data !== undefined
          )
            values.push(entry.payload.data);
        }
        cursor = page.value.nextCursor;
      } while (cursor);
      return ok(values);
    },
    /** @param {string} key */
    async get(key) {
      return store.read({ namespace: 'car/config', scope, key }, context);
    },
    /** @param {string} key @param {Contracts.Json} value */
    async set(key, value) {
      const current = await store.read({ namespace: 'car/config', scope, key }, context);
      if (!current.ok) return current;
      return store.commit(
        {
          id: crypto.randomUUID(),
          append: [],
          mutations: [
            {
              address: { namespace: 'car/config', scope, key },
              expected: current.value?.revision ?? 'absent',
              next: { schemaVersion: 1, value },
            },
          ],
        },
        context,
      );
    },
  };
}
