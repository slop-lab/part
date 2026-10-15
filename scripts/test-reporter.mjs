// @ts-check
import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';

/** Keep Node's failure details and run summary without listing successful tests.
 * @param {AsyncIterable<import('node:test/reporters').TestEvent>} source
 */
export default async function* failures(source) {
  yield* Readable.from(filter(source)).pipe(new spec());
}

/** @param {AsyncIterable<import('node:test/reporters').TestEvent>} source */
async function* filter(source) {
  for await (const event of source) {
    if (event.type === 'test:fail' && !event.data.todo && !event.data.skip) yield event;
    else if (
      ['test:diagnostic', 'test:summary', 'test:coverage', 'test:stdout', 'test:stderr'].includes(
        event.type,
      )
    )
      yield event;
  }
}
