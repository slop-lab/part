import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startMockProvider, readFixture } from '@part/node/testing/mock-provider';
import { createMockFlow } from './flow.mjs';
const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../../fixtures/mock-provider/${name}`, import.meta.url), 'utf8'),
  );
const fixture = readFixture(await load('tool-flow.fixture.json'));
const provider = await startMockProvider({
  mode: 'fixed',
  project: { id: 'part/mock-tool-flow' },
  fixture,
});
const flow = createMockFlow(provider.session);
try {
  const result = await flow.run();
  provider.verify();
  const transcript = { provider: provider.transcript(), ...result };
  assert.deepEqual(transcript, await load('fixed-tool-flow.transcript.json'));
  console.log(JSON.stringify(transcript, null, 2));
} finally {
  await flow.dispose();
  await provider.close();
}
