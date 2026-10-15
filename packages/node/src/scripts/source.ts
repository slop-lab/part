import { digest, fail, ok } from '@slop-lab/part/contracts';
import type { Contracts, Scripts } from '@slop-lab/part/reference';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { NodeScriptOptions } from './types.js';
export async function resolveScriptSource(
  options: NodeScriptOptions,
  request: Scripts.Request,
  context: Contracts.InvocationContext,
): Promise<Contracts.Result<{ bytes: Uint8Array; workspace: string }>> {
  const root = resolve(options.root);
  const path = request.source.relativePath;
  if (isAbsolute(path)) return fail('scripts.path', 'Script path must be relative');
  let bytes: Uint8Array,
    workspace = root;
  if (request.workspace) {
    const selected = await options.workspace!(request.workspace, context);
    if (!selected.ok) return selected;
    workspace = await realpath(selected.value);
  }
  if (request.source.packageId) {
    const selected = await options.source!(request.source, context);
    if (!selected.ok) return selected;
    bytes = selected.value.slice();
  } else {
    try {
      const actual = await realpath(resolve(root, path)),
        base = await realpath(root),
        local = relative(base, actual);
      if (!local || local === '..' || local.startsWith('../') || isAbsolute(local))
        return fail('scripts.path', 'Script is outside the configured root', 'permission');
      if ((await stat(actual)).size > (options.maxSourceBytes ?? 16 * 1024 * 1024))
        return fail('scripts.source-size', 'Script exceeds source byte limit');
      bytes = await readFile(actual);
    } catch {
      return fail('scripts.source', 'Script source unavailable', 'unavailable');
    }
  }
  if (bytes.length > (options.maxSourceBytes ?? 16 * 1024 * 1024))
    return fail('scripts.source-size', 'Script exceeds source byte limit');
  if ((await digest(bytes)) !== request.source.digest)
    return fail('scripts.digest', 'Script content changed', 'conflict');

  return ok({ bytes, workspace });
}
