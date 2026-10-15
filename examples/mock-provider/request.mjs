import { readFile } from 'node:fs/promises';
import { readMockSession } from '@part/node/testing/mock-provider';
import { createMockFlow } from './flow.mjs';
const session = readMockSession(JSON.parse(await readFile(process.argv[2], 'utf8')));
const flow = createMockFlow(session);
try {
  console.log(JSON.stringify(await flow.run(), null, 2));
} finally {
  await flow.dispose();
}
