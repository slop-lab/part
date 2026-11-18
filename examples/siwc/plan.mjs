// @ts-check
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createChatGPTSession,
  hasChatGPTPlanAccess,
  signInWithChatGPTLoopback,
} from '@slop-lab/part-node/siwc/index.js';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createChatGPTModel } from '@slop-lab/part-plugins/providers/index.js';

/** @typedef {import('@slop-lab/part-node/siwc/index.js').ChatGPTRegistration} Registration */
/** @typedef {{hostId: string, registration?: Registration}} SavedAccount */

const directory =
  process.env.PART_SIWC_DIRECTORY ?? join(homedir(), '.config', 'part-siwc-example');
const filename = join(directory, 'account.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
// The same account is held by one process while it may sign in or rotate its refresh token.
const lockPath = join(directory, 'account.lock');
const lock = await open(lockPath, 'wx', 0o600);
try {
  /** @type {SavedAccount} */
  let saved;
  try {
    saved = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    saved = { hostId: `urn:uuid:${randomUUID()}` };
  }

  /** @param {SavedAccount} account */
  async function save(account) {
    const staged = join(directory, `account.${randomUUID()}.tmp`);
    try {
      await writeFile(staged, JSON.stringify(account), { mode: 0o600, flag: 'wx' });
      await rename(staged, filename);
    } finally {
      await unlink(staged).catch(() => {});
    }
  }
  await save(saved);
  let registration = saved.registration;
  const command = process.argv[2] ?? 'models';
  if (command === 'signin' || !registration) {
    registration = await signInWithChatGPTLoopback({
      appName: 'part SIWC example',
      hostId: saved.hostId,
      registration: registration && {
        identity: registration.identity,
        hostId: registration.hostId,
      },
      requestConsent: registration !== undefined && !hasChatGPTPlanAccess(registration),
      open(url) {
        console.log('Open this URL in your browser to continue with ChatGPT:');
        console.log(url.href);
      },
    });
    await save({ hostId: saved.hostId, registration });
  }
  if (!hasChatGPTPlanAccess(registration)) {
    console.log('Signed in. ChatGPT plan usage has not been granted.');
  } else if (command !== 'signin') {
    const session = createChatGPTSession({
      credentials: registration,
      save: (credentials) => save({ hostId: saved.hostId, registration: credentials }),
    });
    if (command === 'models') {
      console.table(await session.listModels());
    } else {
      const model = process.env.PART_SIWC_MODEL;
      if (command !== 'ask' || !model)
        throw new Error('Run models, signin, or ask with PART_SIWC_MODEL set to a listed model ID');
      const agent = createAgent({
        model: createChatGPTModel({ model, accessToken: session.accessToken, timeoutMs: 90_000 }),
      });
      if (!agent.ok) throw new Error(agent.error.message);
      try {
        const result = await agent.value.generate(process.argv[3] ?? 'Say hello.');
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.phase !== 'completed')
          throw new Error(result.value.error?.message ?? `Model run ${result.value.phase}`);
        for (const part of result.value.result.content)
          if (part.kind === 'text') console.log(part.text);
      } finally {
        await agent.value.dispose();
      }
    }
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
