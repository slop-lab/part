// @ts-check
import { readMockSession } from '@slop-lab/part-node/testing/mock-provider/index.js';
import { readFile } from 'node:fs/promises';
import { createMockFlow } from './flow.mjs';
const session = readMockSession(
  JSON.parse(
    await readFile(
      process.argv[2] ??
        (() => {
          throw Error('Pass a request JSON file');
        })(),
      'utf8',
    ),
  ),
);
const flow = createMockFlow(session);
try {
  console.log(JSON.stringify(await flow.run(), null, 2));
} finally {
  await flow.dispose();
}
