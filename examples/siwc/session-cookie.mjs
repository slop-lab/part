// @ts-check
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {string} directory @param {string} name @param {() => string} generate */
export async function readOrCreatePrivateValue(directory, name, generate) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (await stat(directory)).mode & 0o077)
    throw new Error('Use a private directory for local ChatGPT state');
  const target = join(directory, name);
  try {
    return (await readFile(target, 'utf8')).trim();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const staged = join(directory, `.${name}.${randomUUID()}`);
  await writeFile(staged, generate(), { mode: 0o600, flag: 'wx' });
  try {
    await link(staged, target);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  } finally {
    await unlink(staged);
  }
  return (await readFile(target, 'utf8')).trim();
}

/** @param {string | undefined} header @param {string} name */
export function cookieValue(header, name) {
  return header
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** @param {string} directory */
export function createExampleSessionCookies(directory) {
  /** @type {Promise<string> | undefined} */
  let key;
  /** @param {string} id */
  async function sign(id) {
    key ??= readOrCreatePrivateValue(directory, 'cookie-key', () =>
      randomBytes(32).toString('hex'),
    ).catch((error) => {
      key = undefined;
      throw error;
    });
    const secret = await key;
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid local session key');
    return createHmac('sha256', Buffer.from(secret, 'hex')).update(id).digest('base64url');
  }
  return {
    /** @param {string} id */
    async issue(id) {
      return `${id}.${await sign(id)}`;
    },
    /** @param {string | undefined} value */
    async restore(value) {
      const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
      const id = match?.[1],
        signature = match?.[2];
      if (id && signature && timingSafeEqual(Buffer.from(signature), Buffer.from(await sign(id))))
        return id;
    },
  };
}
