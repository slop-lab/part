// @ts-check
import { access, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/** Resolve host-owned command aliases once; never inherit provider secrets.
 * @param {string} stateDirectory */
export async function resolveCommands(stateDirectory) {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  /** @type {Record<string, string | {command: string, args: readonly string[]}>} */
  const commands = { node: process.execPath };
  for (const name of ['git', 'npm', 'npx', 'pnpm']) {
    for (const directory of paths) {
      const candidate = join(
        directory,
        process.platform === 'win32' ? `${name}.${name === 'git' ? 'exe' : 'cmd'}` : name,
      );
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        let resolved = await realpath(candidate);
        if (process.platform === 'win32' && (name === 'npm' || name === 'npx')) {
          resolved = join(
            dirname(process.execPath),
            'node_modules',
            'npm',
            'bin',
            `${name}-cli.js`,
          );
          await access(resolved);
        }
        if (/\.[cm]?js$/.test(resolved))
          commands[name] = { command: process.execPath, args: [resolved] };
        else if (!/\.cmd$/i.test(resolved)) commands[name] = resolved;
        break;
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code))
        ))
          throw error;
      }
    }
  }
  const home = join(stateDirectory, 'process-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const environment = {
    PATH: paths.join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    LANG: 'C.UTF-8',
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  return { commands, environment };
}
