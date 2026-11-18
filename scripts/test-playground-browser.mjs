// @ts-check
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startPlayground } from '../examples/playground/server.mjs';
import { present } from '../fixtures/assertions.mjs';

const serverKey = 'browser-test-server-only-key';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let planModels = 0;
const directory = await mkdtemp(join(tmpdir(), 'part-playground-siwc-'));
/** @type {NonNullable<Parameters<typeof startPlayground>[0]>} */
const options = {
  port: 0,
  delayScale: 0.15,
  environment: {
    OPENAI_API_KEY: serverKey,
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    OPENAI_MODEL: 'browser-test-model',
    PART_SIWC_HOST_ID: 'urn:uuid:browser-test',
    PART_SIWC_DIRECTORY: directory,
  },
  async fetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/jwks.json'))
      return Response.json({
        keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'browser-test' }],
      });
    if (url.pathname.endsWith('/oauth/token')) {
      assert.ok(init?.body instanceof URLSearchParams);
      const now = Math.floor(Date.now() / 1000);
      const data = [
        { alg: 'RS256', kid: 'browser-test' },
        {
          iss: url.origin,
          sub: 'browser-user',
          name: 'Browser Test',
          aud: 'oaiapp_browser',
          nonce: init.body.get('code'),
          iat: now,
          exp: now + 300,
        },
      ]
        .map((entry) => Buffer.from(JSON.stringify(entry)).toString('base64url'))
        .join('.');
      return Response.json({
        id_token:
          data + '.' + sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url'),
        access_token: 'browser-plan-test-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid resource.invoke chatgpt.tokens.use.direct',
      });
    }
    const bearer = new Headers(init?.headers).get('authorization');
    if (url.href === 'https://api.openai.com/v1/models') {
      assert.equal(bearer, 'Bearer browser-plan-test-token');
      if (++planModels === 1)
        return Response.json(
          { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
          { status: 429, headers: { 'x-request-id': 'req_browser_test' } },
        );
      if (planModels === 2) return Response.json({ models: [] });
      return Response.json({
        models: [
          { slug: 'plan-model', display_name: 'Plan model', visibility: 'list' },
          { slug: 'plan-model-2', display_name: 'Second plan model', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden model', visibility: 'hidden' },
        ],
      });
    }
    assert.equal(url.pathname, '/v1/responses');
    const encoded = await new Response(init?.body).json();
    const plan = bearer === 'Bearer browser-plan-test-token';
    assert.equal(bearer, plan ? 'Bearer browser-plan-test-token' : `Bearer ${serverKey}`);
    assert.equal(encoded.model, plan ? 'plan-model-2' : 'browser-test-model');
    const terminal = {
      type: 'response.completed',
      response: {
        id: 'resp_browser_test',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_browser_test',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: plan ? 'Plan reply' : 'Configured provider reply' },
            ],
          },
        ],
      },
    };
    return new Response(
      'data: {"type":"codex.rate_limits"}\n\ndata: ' + JSON.stringify(terminal) + '\n\n',
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  },
};
let server = await startPlayground(options);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  assert.equal((await fetch(`${server.url}/api/queries`, { method: 'POST' })).status, 403);
  assert.equal(
    (await fetch(`${server.url}/api/bootstrap`, { headers: { origin: 'https://other.invalid' } }))
      .status,
    403,
  );
  const bootstrap = await fetch(`${server.url}/api/bootstrap`);
  assert.equal((await bootstrap.text()).includes(serverKey), false);
  assert.match(bootstrap.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  assert.equal((await (await fetch(`${server.url}/app.js`)).text()).includes(serverKey), false);
  await page.goto(server.url);
  await page.locator('#connection[data-state="connected"]').waitFor();
  let runs = 0;
  /** @param {string} value */
  const phase = async (value) =>
    page.waitForFunction(
      (expected) => document.querySelector('#run-status')?.textContent?.startsWith(expected),
      value,
    );
  /** @param {string} scenario @param {string | null} final */
  const run = async (scenario, final = 'completed') => {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    await page.getByRole('button', { name: 'Try this example' }).click();
    runs++;
    await page.waitForFunction(
      (count) => document.querySelector('#turn-count')?.textContent?.startsWith(`${count} `),
      runs,
    );
    if (final) await phase(final);
  };
  /** @returns {Promise<ReturnType<ReturnType<import("../examples/playground/runtime.mjs").createPlaygroundSession>["state"]>>} */
  const session = () =>
    page.evaluate(
      async () =>
        (
          await (
            await fetch('/api/queries', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ queryId: 'playground/state', version: 1, input: null }),
            })
          ).json()
        ).value,
    );
  await run('conversation');
  assert.match(
    await page.locator('[data-part-part="thread"]').innerText(),
    /Small steps, visible progress/,
  );
  assert.match(await page.locator('#inspect-requests').innerText(), /digest/);
  await run('tools');
  assert.equal(
    (await session()).runs.at(-1)?.events.filter((event) => event.kind === 'tool-start').length,
    1,
  );
  await run('approval', null);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await phase('failed');
  assert.equal((await session()).note, '');
  await run('approval', null);
  await page.getByLabel('Rich cards').uncheck();
  await page.getByRole('button', { name: 'playground/approve', exact: true }).click();
  await phase('completed');
  await page.getByRole('tab', { name: 'Note', exact: true }).click();
  assert.match(await page.locator('#note-content').innerText(), /Ship a small version/);
  await page.getByLabel('Rich cards').check();
  await run('artifact');
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  await page.getByRole('button', { name: 'Load artifact', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('#inspect-items')?.textContent?.includes('# Runtime field notes'),
  );
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download ↓', exact: true }).click();
  assert.equal((await download).suggestedFilename(), 'runtime-report.md');
  await run('failure', 'failed');
  assert.equal(
    (await session()).runs.at(-1)?.events.filter((event) => event.kind === 'tool-start').length,
    0,
  );
  await run('cancellation', null);
  await page.waitForFunction(() =>
    document.querySelector('[data-part-part="thread"]')?.textContent?.includes('Step 1'),
  );
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  assert.ok((await session()).active);
  await page.getByRole('button', { name: 'Stop run' }).click();
  await phase('cancelled');
  await page.reload();
  await page.locator('#connection[data-state="connected"]').waitFor();
  await phase('cancelled');
  assert.equal((await session()).runs.length, runs);
  const draft = page.getByRole('textbox', { name: 'Message', exact: true });
  await draft.fill('Draft survives a renderer change.');
  await page.getByLabel('Rich cards').uncheck();
  assert.equal(
    await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
    'Draft survives a renderer change.',
  );
  await page.getByLabel('Rich cards').check();
  await page.getByRole('button', { name: 'Guide ↗', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear session' }).click();
  await page.waitForFunction(() => document.querySelector('#turn-count')?.textContent === '0 runs');
  assert.equal((await session()).note, '');
  await page.locator('[data-scenario="tools"]').click();
  await page.getByRole('button', { name: 'Try this example' }).click();
  await phase('completed');
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto(server.url);
  await other.locator('#connection[data-state="connected"]').waitFor();
  assert.equal(await other.locator('#turn-count').innerText(), '0 runs');
  await second.close();
  const screenshots = process.env.PART_SCREENSHOTS;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: `${screenshots}/playground-desktop.png`, fullPage: true });
  }
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Horizontal overflow at ${width}px`,
    );
    if (width === 390) {
      await page.getByLabel('Dark', { exact: true }).check();
      assert.equal(
        await page.locator('#example-title').evaluate((node) => getComputedStyle(node).color),
        'rgb(232, 238, 230)',
      );
      if (screenshots)
        await page.screenshot({ path: `${screenshots}/playground-mobile.png`, fullPage: true });
      await page.getByLabel('Dark', { exact: true }).uncheck();
    }
  }
  assert.ok((await session()).runs.every((entry) => entry.provider === 'scripted'));
  await page.getByLabel('Model provider').selectOption('responses');
  assert.equal(await page.getByLabel('Model name').inputValue(), 'browser-test-model');
  await page.locator('[data-scenario="conversation"]').click();
  await page.getByRole('button', { name: 'Try this example' }).click();
  await phase('completed · responses');
  assert.equal((await session()).runs.at(-1)?.text, 'Configured provider reply');

  await page.getByRole('button', { name: 'Connect ChatGPT' }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click();
  const auth = new URL(
    present(await page.getByRole('link', { name: /Open ChatGPT sign-in/ }).getAttribute('href')),
  );
  const callback = new URL(present(auth.searchParams.get('redirect_uri')));
  callback.searchParams.set('state', present(auth.searchParams.get('state')));
  callback.searchParams.set('code', present(auth.searchParams.get('nonce')));
  callback.searchParams.set('client_id', 'oaiapp_browser');
  await page.getByLabel('Callback URL').fill(callback.href);
  await page.getByRole('button', { name: 'Complete sign-in' }).click();
  await page.getByRole('button', { name: 'Load ChatGPT models' }).click();
  await page
    .locator('#siwc-status')
    .filter({ hasText: /HTTP 429.*req_browser_test/ })
    .waitFor();
  await page.getByRole('button', { name: 'Load ChatGPT models' }).click();
  await page
    .locator('#siwc-status')
    .filter({ hasText: 'This account returned no displayable models.' })
    .waitFor();
  const modelList = page.getByRole('listbox', { name: 'Available ChatGPT models' });
  assert.equal(await modelList.isVisible(), false);
  await page.getByRole('button', { name: 'Load ChatGPT models' }).click();
  await modelList.waitFor();
  assert.deepEqual(await modelList.locator('option').allTextContents(), [
    'Plan model',
    'Second plan model',
  ]);
  await page.waitForFunction(
    () =>
      document.querySelector('select#provider')?.getAttribute('id') &&
      /** @type {HTMLSelectElement} */ (document.querySelector('select#provider')).value ===
        'chatgpt',
  );
  assert.equal(await page.getByLabel('Model name').inputValue(), 'plan-model');
  await modelList.selectOption('plan-model-2');
  assert.equal(await page.getByLabel('Model name').inputValue(), 'plan-model-2');
  await page.getByRole('button', { name: 'Close ChatGPT connection' }).click();
  await page.getByRole('button', { name: 'Try this example' }).click();
  await phase('completed · chatgpt');
  assert.equal((await session()).runs.at(-1)?.text, 'Plan reply');

  const isolated = await browser.newPage();
  await isolated.goto(server.url);
  await isolated.getByRole('button', { name: 'Connect ChatGPT' }).waitFor();
  assert.notEqual(await isolated.locator('option[value="chatgpt"]').getAttribute('disabled'), null);
  assert.equal((await isolated.content()).includes('browser-plan-test-token'), false);
  await isolated.close();
  const firstURL = server.url;
  await page.goto('about:blank');
  await server.close();
  server = await startPlayground({ ...options, port: Number(new URL(firstURL).port) });
  await page.goto(server.url);
  await page.locator('#connection[data-state="connected"]').waitFor();
  const cookie = present(
    (await page.context().cookies()).find(({ name }) => name === 'part_playground'),
  );
  const otherContext = await browser.newContext();
  await otherContext.addCookies([
    {
      name: cookie.name,
      value: `${cookie.value.split('.')[0]}.${'a'.repeat(43)}`,
      url: server.url,
    },
  ]);
  const otherBrowser = await otherContext.newPage();
  await otherBrowser.goto(server.url);
  await otherBrowser.getByRole('button', { name: 'Connect ChatGPT' }).waitFor();
  await otherContext.close();
  await page.getByRole('button', { name: 'ChatGPT connected' }).click();
  await page.getByText('Signed in as Browser Test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load ChatGPT models' }).click();
  await modelList.waitFor();
  await modelList.selectOption('plan-model-2');
  await page.getByRole('button', { name: 'Close ChatGPT connection' }).click();
  await page.getByRole('button', { name: 'Try this example' }).click();
  await phase('completed · chatgpt');
  assert.equal((await session()).runs.at(-1)?.text, 'Plan reply');
  await page.getByRole('button', { name: 'ChatGPT connected' }).click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).waitFor();
  assert.notEqual(await page.locator('option[value="chatgpt"]').getAttribute('disabled'), null);
  await page.getByRole('button', { name: 'Close ChatGPT connection' }).click();
  assert.deepEqual(errors, []);
  if (screenshots)
    await writeFile(
      `${screenshots}/browser-check.json`,
      JSON.stringify(
        { browser: await browser.version(), scenarios: 6, viewports: [390, 768, 1440], errors },
        null,
        2,
      ),
    );
  console.log(
    'Playground Chromium: all six scenarios, approvals/fallbacks, artifact download, cancellation/reconnect, refresh, isolation, draft retention, responsive layouts, configured provider and isolated SIWC plan flow passed.',
  );
} finally {
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
