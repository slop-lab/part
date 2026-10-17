// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaygroundModel, providerOptions } from '../examples/playground/models.mjs';

test('Playground configures generic OpenAI-compatible providers only with an explicit model', () => {
  const configured = providerOptions({
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: 'https://provider.invalid/v1',
    OPENAI_MODEL: 'test-model',
  });
  assert.deepEqual(
    configured.map(({ id, available }) => ({ id, available })),
    [
      { id: 'scripted', available: true },
      { id: 'responses', available: true },
      { id: 'chat', available: true },
    ],
  );
  assert.ok(configured.slice(1).every(({ label }) => label.startsWith('OpenAI-compatible ·')));
  assert.ok(
    providerOptions({
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
    })
      .slice(1)
      .every(({ available }) => !available),
  );
  assert.equal(
    createPlaygroundModel({
      provider: 'chat',
      scenario: 'conversation',
      prompt: 'hello',
      model: 'test-model',
      environment: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://provider.invalid',
        OPENAI_MODEL: 'test-model',
      },
      trace() {},
      delayScale: 0,
    }).profile.endpoint,
    'https://provider.invalid/chat/completions',
  );
});

test('Playground rejects unsafe OpenAI-compatible provider configuration', () => {
  /** @param {NodeJS.ProcessEnv} environment */
  const configure = (environment) =>
    createPlaygroundModel({
      provider: 'chat',
      scenario: 'conversation',
      prompt: 'hello',
      model: 'test-model',
      environment: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_MODEL: 'test-model',
        ...environment,
      },
      trace() {},
      delayScale: 0,
    });
  assert.throws(
    () => configure({ OPENAI_BASE_URL: 'https://user:secret@provider.invalid/v1' }),
    /credentials/,
  );
  for (const name of ['Authorization', 'Content-Type', 'Host', 'Content-Length', 'Connection'])
    assert.throws(
      () => configure({ OPENAI_HEADERS: JSON.stringify({ [name]: 'unsafe' }) }),
      new RegExp(name, 'i'),
    );
  assert.throws(() => configure({ OPENAI_HEADERS: '{invalid' }), /OPENAI_HEADERS/);
  assert.throws(() => configure({ OPENAI_HEADERS: JSON.stringify({ 'x-project': 42 }) }), /string/);
});

test('Playground passes safe OpenAI-compatible headers without weakening transport controls', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {{url?: string, headers?: Headers, redirect?: RequestRedirect}} */
  const captured = {};
  globalThis.fetch = async (url, init) => {
    captured.url = String(url);
    captured.headers = new Headers(init?.headers);
    captured.redirect = init?.redirect;
    return new Response(
      JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'HELLO' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const created = createAgent({
    model: createPlaygroundModel({
      provider: 'chat',
      scenario: 'conversation',
      prompt: 'hello',
      model: 'test-model',
      environment: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://provider.invalid/v1',
        OPENAI_MODEL: 'test-model',
        OPENAI_HEADERS: JSON.stringify({ 'x-project': 'example' }),
      },
      trace() {},
      delayScale: 0,
    }),
  });
  assert.equal(created.ok, true);
  try {
    const result = await created.value.generate('Reply with HELLO.');
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'https://provider.invalid/v1/chat/completions');
    assert.equal(captured.headers?.get('authorization'), 'Bearer test-key');
    assert.equal(captured.headers?.get('content-type'), 'application/json');
    assert.equal(captured.headers?.get('x-project'), 'example');
    assert.equal(captured.redirect, 'error');
  } finally {
    globalThis.fetch = originalFetch;
    await created.value.dispose();
  }
});
