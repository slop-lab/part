// @ts-check
import { createCarWorkflowRegistry } from '../car/src/workflows.mjs';
import { jsonSchema, localContext } from '@slop-lab/part/contracts/index.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty } from '../fixtures/assertions.mjs';

const context = localContext();

/** @param {string} id */
const pipeline = (id) => ({
  format: /** @type {const} */ ('part.pipeline'),
  version: /** @type {const} */ (1),
  id,
  input: jsonSchema.ref,
  output: jsonSchema.ref,
  steps: [{ id: 'check', after: [], kind: 'assert', value: { input: '/approved' }, equals: true }],
  result: { input: '' },
});

test('CAR workflow registry loads pinned pipeline JSON and executes through the workflow host', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'car-workflows-'));
  try {
    const directory = join(root, '.agents', 'workflows');
    await mkdir(directory, { recursive: true });
    const definition = pipeline('review');
    await writeFile(join(directory, 'review.pipeline.json'), JSON.stringify(definition));

    // When
    const created = await createCarWorkflowRegistry({
      root,
      schemas: [jsonSchema],
      services: {},
      context,
    });

    // Then
    const registry = expectProperty(created, 'value');
    assert.match(registry.definitions[0]?.digest ?? '', /^[a-f0-9]{64}$/);
    const submitted = await registry.start('review', { approved: true }, { requestId: 'one' });
    assert.equal(submitted.kind, 'accepted');
    const engine = expectProperty(registry.host.resolve(submitted.ref.engine), 'value');
    let phase = 'running';
    for (let attempt = 0; attempt < 100 && phase === 'running'; attempt++) {
      phase = expectProperty(await engine.get(submitted.ref, context), 'value').phase;
      if (phase === 'running') await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(phase, 'succeeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CAR workflow registry rejects unsupported primitives and unavailable engines before start', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'car-workflows-'));
  try {
    const directory = join(root, '.agents', 'workflows');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'bad.pipeline.json'),
      JSON.stringify({ ...pipeline('bad'), steps: [{ id: 'bad', after: [], kind: 'shell' }] }),
    );

    // When
    const unsupported = await createCarWorkflowRegistry({
      root,
      schemas: [jsonSchema],
      services: {},
      context,
    });

    // Then
    assert.equal(unsupported.ok, false);
    await rm(join(root, '.agents'), { recursive: true, force: true });
    const missing = await createCarWorkflowRegistry({
      root,
      schemas: [jsonSchema],
      services: {},
      context,
      registrations: [
        {
          engineId: 'missing',
          definition: {
            id: 'external',
            format: 'native',
            formatVersion: '1',
            digest: 'pinned',
            source: { owner: 'test', native: {} },
          },
        },
      ],
    });
    assert.equal(missing.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CAR workflow registry rejects a workflows directory symlink that escapes the root', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'car-workflows-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'car-workflows-outside-'));
  try {
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(outside, 'escaped.pipeline.json'), JSON.stringify(pipeline('escaped')));
    await symlink(outside, join(root, '.agents', 'workflows'), 'dir');

    // When
    const created = await createCarWorkflowRegistry({
      root,
      schemas: [jsonSchema],
      services: {},
      context,
    });

    // Then
    assert.equal(created.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
