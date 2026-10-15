// @ts-check
// Compile-only regressions: npm run check:js must reject the marked invalid uses.
import { stub } from './assertions.mjs';

/** @import {Client} from '@slop-lab/part/reference/index.js' */
/** @param {ReturnType<import('../scripts/package-metadata.mjs').readPackageMetadata>} metadata
 * @param {ReturnType<import('../examples/playground/runtime.mjs').createPlaygroundSession>} session
 */
export function checkTypeContracts(metadata, session) {
  // @ts-expect-error Manifest names are strings, not untyped parsed JSON.
  metadata.name.toFixed();
  // @ts-expect-error Optional lookups must be checked before use.
  metadata.dependencies.missing.toUpperCase();
  // @ts-expect-error Events contain JSON data whose shape must be narrowed.
  session.state().runs[0].events[0].data.nonexistent();
  // @ts-expect-error Commands must satisfy the actual endpoint request contract.
  session.endpoint.command({ actionId: 123 });

  /** @type {Client.Endpoint} */
  const endpoint = stub({
    // @ts-expect-error Implemented test-double methods must return the actual contract.
    query: async () => 'not a Result',
  });
  return endpoint;
}
