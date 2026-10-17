// @ts-check
import { execFile } from 'node:child_process';
import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import { WorkspaceFiles } from '@slop-lab/part-node/swe/files.js';

/** @param {string} root */
export function createWorkspaceView(root) {
  const files = new WorkspaceFiles(root, {
    maxFileBytes: 1024 * 1024,
    maxOutputChars: 100_000,
    maxEntries: 1000,
  });
  /** @param {unknown} input */
  const path = (input) =>
    isJsonObject(input) && typeof input.path === 'string' ? input.path : undefined;
  return {
    /** @param {unknown} input */
    async read(input) {
      const selected = path(input);
      if (!selected) return fail('car.path', 'Expected a relative workspace path');
      try {
        return ok(await files.read(selected));
      } catch (error) {
        return fail('car.file', error instanceof Error ? error.message : 'File unavailable');
      }
    },
    /** @param {unknown} input @param {AbortSignal} signal */
    async diff(input, signal) {
      const selected = path(input);
      if (!selected) return fail('car.path', 'Expected a relative workspace path');
      const checked = await this.read(input);
      if (!checked.ok) return checked;
      return new Promise((resolve) => {
        execFile(
          'git',
          [
            '--no-optional-locks',
            '-C',
            root,
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--',
            selected,
          ],
          {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 1024 * 1024,
            signal,
            env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat' },
          },
          (error, stdout, stderr) =>
            resolve(
              error
                ? fail(
                    'car.diff',
                    'Git diff unavailable (repository and tracked path required)',
                    'unavailable',
                  )
                : ok({ path: selected, diff: stdout, stderr }),
            ),
        );
      });
    },
  };
}
