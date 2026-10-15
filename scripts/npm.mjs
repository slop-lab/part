// @ts-check
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** Invoke npm through Node so Windows does not need a shell or a .cmd shim.
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} options
 */
export function npmSync(args, options) {
  if (!process.env.npm_execpath && process.platform !== 'win32')
    return spawnSync('npm', args, options);
  const cli =
    process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  return spawnSync(process.execPath, [cli, ...args], options);
}
