// @ts-check
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPlayground } from '../examples/playground/server.mjs';

const serverKey = 'browser-test-server-only-key';
const server = await startPlayground({
  port: 0,
  delayScale: 0.15,
  environment: { R4U_API_KEY: serverKey, R4U_BASE_URL: 'http://127.0.0.1:9/v1' },
});
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
    'Playground Chromium: all six scenarios, approvals/fallbacks, artifact download, cancellation/reconnect, refresh, isolation, draft retention and responsive layouts passed.',
  );
} finally {
  await browser?.close();
  await server.close();
}
