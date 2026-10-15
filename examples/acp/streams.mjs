// @ts-check

/** Bridge Node byte streams to the Web stream contract used by the ACP SDK.
 * @param {import('node:stream').Readable} source
 * @returns {ReadableStream<Uint8Array>}
 */
export function byteStream(source) {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      /** @type {IteratorResult<unknown>} */
      const next = await iterator.next();
      if (next.done) controller.close();
      else {
        if (!(next.value instanceof Uint8Array)) throw Error('Expected a byte stream');
        controller.enqueue(next.value);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
