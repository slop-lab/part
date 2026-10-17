// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCarModel, readCarModelEnvironment } from '../car/src/model.mjs';
import { localContext } from '@slop-lab/part/contracts/index.js';

test('CAR resolves generic model environment with explicit CLI overrides', () => {
  const options = readCarModelEnvironment(
    {
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
      OPENAI_API_KEY: 'inert-key',
      OPENAI_MODEL: 'configured-model',
      OPENAI_HEADERS: '{"x-project":"local"}',
    },
    { baseURL: 'https://override.invalid/api', model: 'override-model' },
  );
  assert.equal(options.baseURL, 'https://override.invalid/api');
  assert.equal(options.model, 'override-model');
  assert.deepEqual(options.headers, { 'x-project': 'local' });
});

test('CAR sends only explicit generic headers and preserves authentication and redirect controls', async () => {
  const original = globalThis.fetch;
  /** @type {Headers | undefined} */
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = new Headers(init?.headers);
    assert.equal(init?.redirect, 'error');
    return new Response('{}', { status: 200 });
  };
  try {
    const model = createCarModel({
      baseURL: 'https://provider.invalid/v1',
      apiKey: 'inert-key',
      model: 'configured-model',
      headers: { 'x-project': 'local' },
    });
    const result = await model.transport.send(
      {
        protocol: 'http',
        mediaType: 'application/json',
        body: new TextEncoder().encode('{}'),
        digest: 'test',
        metadata: {},
        inspectionBoundary: 'outgoing-body',
      },
      model.profile,
      { strategy: 'bearer', material: 'inert-key' },
      localContext(),
    );
    assert.ok(result.ok && sent);
    assert.equal(sent.get('authorization'), 'Bearer inert-key');
    assert.equal(sent.get('content-type'), 'application/json');
    assert.equal(sent.get('x-project'), 'local');
    assert.equal([...sent.keys()].length, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test('CAR rejects invalid or protected custom header configuration before transport', () => {
  for (const name of ['Authorization', 'Content-Type', 'Host', 'Connection', 'Content-Length'])
    assert.throws(
      () =>
        createCarModel({
          baseURL: 'https://provider.invalid/v1',
          apiKey: 'inert-key',
          model: 'configured-model',
          headers: { [name]: 'unsafe' },
        }),
      /protected/,
    );
  assert.throws(() => readCarModelEnvironment({ OPENAI_HEADERS: '{bad' }), /OPENAI_HEADERS/);
  assert.throws(() => readCarModelEnvironment({ OPENAI_HEADERS: '{"x-project":42}' }), /string/);
  assert.throws(
    () =>
      createCarModel({
        baseURL: 'https://provider.invalid/v1',
        apiKey: 'inert-key',
        model: 'configured-model',
        headers: { 'x-project': 'private-value\ninvalid' },
      }),
    (error) => error instanceof TypeError && !error.message.includes('private-value'),
  );
});
