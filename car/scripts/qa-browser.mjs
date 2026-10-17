// @ts-check
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  createMockProviderClient,
  readMockSession,
} from '@slop-lab/part-node/testing/mock-provider/index.js';

const [url, sessionPath, token, evidenceDirectory] = process.argv.slice(2);
if (!url || !sessionPath || !token || !evidenceDirectory)
  throw new TypeError('Usage: qa-browser.mjs URL MOCK_SESSION TEST_TOKEN EVIDENCE_DIRECTORY');
await mkdir(evidenceDirectory, { recursive: true });
const operator = createMockProviderClient(
  readMockSession(JSON.parse(await readFile(sessionPath, 'utf8'))),
);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
/** @type {string[]} */
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(url);
  await page.getByLabel('Bearer token').fill('invalid-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('[data-car-state="error"]').waitFor();
  await page.screenshot({ path: join(evidenceDirectory, 'invalid-token.png'), fullPage: true });
  await page.getByLabel('Bearer token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('[data-car-state="connected"]').waitFor();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('한국어 입력과 실제 개발 도구를 확인합니다.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  let request = (await operator.pending(10_000, AbortSignal.timeout(15_000)))[0];
  assert.ok(request);
  await operator.respond(request.id, 'browser/exec', {
    kind: 'completion',
    content: null,
    toolCalls: [
      {
        id: 'browser-tool',
        name: 'swe_exec',
        arguments: JSON.stringify({
          command: 'node',
          args: ['-e', "console.log('개발 도구 실행 확인')"],
        }),
      },
    ],
  });
  request = (await operator.pending(10_000, AbortSignal.timeout(15_000)))[0];
  assert.ok(request);
  await operator.respond(request.id, 'browser/final', {
    kind: 'completion',
    content: '개발 도구 실행을 확인했습니다. 작업 결과와 요청을 검사할 수 있습니다.',
    textChunks: ['개발 도구 실행을 ', '확인했습니다. 작업 결과와 요청을 검사할 수 있습니다.'],
  });
  await page
    .getByText('개발 도구 실행을 확인했습니다. 작업 결과와 요청을 검사할 수 있습니다.', {
      exact: true,
    })
    .waitFor();
  await page.getByRole('tab', { name: 'Workflows', exact: true }).click();
  await page.getByLabel('Registered definition').selectOption('0');
  await page.getByLabel('JSON input', { exact: true }).fill('{}');
  await page.getByRole('button', { name: 'Start workflow', exact: true }).click();
  const response = page.getByLabel('JSON input for part.workflow/respond');
  await response.waitFor();
  /** @type {unknown} */
  const envelope = JSON.parse(await response.inputValue());
  assert.ok(envelope && typeof envelope === 'object');
  await response.fill(JSON.stringify({ ...envelope, response: { approved: true } }));
  await response.locator('..').getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByText('State: succeeded · effect: not-attempted', { exact: true }).waitFor();
  const tabs = [
    'Runs',
    'History',
    'Context',
    'Requests',
    'Events',
    'Workspace',
    'Diff',
    'Artifact',
    'Items',
    'Workflows',
  ];
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of tabs) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      if (tab === 'Workspace' || tab === 'Diff') {
        await page.getByLabel('Workspace path').fill('README.md');
        await page.getByRole('button', { name: 'Load', exact: true }).click();
      }
      await page
        .locator('.car-inspector-status')
        .filter({ hasText: /Loading/ })
        .waitFor({ state: 'hidden' });
      if (tab === 'Workflows')
        await page
          .locator('.car-workflow-launcher [data-state="loading"]')
          .waitFor({ state: 'hidden' });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        `Overflow at ${width}/${tab}`,
      );
      await page.screenshot({
        path: join(evidenceDirectory, `${width}-${tab.toLowerCase()}.png`),
        fullPage: true,
      });
    }
  }
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Cancel this pending request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  assert.ok((await operator.pending(10_000, AbortSignal.timeout(15_000)))[0]);
  await page.getByRole('button', { name: 'part.run/cancel', exact: true }).click();
  await page.getByText('Cancelled', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: 'Chromium',
      widths: [375, 768, 1280],
      captures: 31,
      interactions: [
        'invalid-token retry',
        'Korean message',
        'node alias tool',
        'stream',
        'workflow approval',
        'inspector tabs',
        'cancel',
      ],
      pageErrors: errors,
    }),
  );
} finally {
  await browser.close();
}
