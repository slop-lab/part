import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { digest, fail, freeze, ok } from '../foundation/contracts.js';
import type { Contracts, Packages } from '../reference/index.js';
export function createDirectoryPackages(options: { maxBytes?: number } = {}): Packages.Source {
  const installed = new Map<string, { snapshot: Packages.Snapshot; root: string }>();
  return {
    async discover(roots, context) {
      const snapshots: Packages.Snapshot[] = [];
      for (const root of roots) {
        if (context.signal.aborted)
          return fail('package.cancelled', 'Discovery cancelled', 'cancelled');
        let base: string;
        try {
          base = await realpath(root);
        } catch {
          return fail('package.root', 'Package root unavailable', 'unavailable');
        }
        const assets: Packages.Asset[] = [];
        let bytes = 0;
        const scan = async (directory: string): Promise<Contracts.Result<void>> => {
          const entries = await readdir(directory, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
          for (const entry of entries) {
            if (entry.isSymbolicLink())
              return fail('package.symlink', 'This loader rejects symlinks', 'permission');
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
              const scanned = await scan(path);
              if (!scanned.ok) return scanned;
            } else if (entry.isFile()) {
              const content = await readFile(path);
              bytes += content.byteLength;
              if (bytes > (options.maxBytes ?? 16 * 1024 * 1024))
                return fail('package.size', 'Package exceeds byte limit');
              assets.push({
                path: relative(base, path).split('\\').join('/'),
                digest: await digest(content),
                bytes: content.byteLength,
                mediaType: path.endsWith('.md')
                  ? 'text/markdown'
                  : path.endsWith('.json')
                    ? 'application/json'
                    : 'application/octet-stream',
              });
            } else return fail('package.file', 'Unsupported package file type', 'unsupported');
          }
          return ok(undefined);
        };
        try {
          const scanned = await scan(base);
          if (!scanned.ok) return scanned;
        } catch {
          return fail('package.scan', 'Package scan failed', 'unavailable');
        }
        const hash = await digest(assets as unknown as Contracts.Json),
          id = `${basename(base)}/${hash}`;
        const snapshot: Packages.Snapshot = freeze({
          id,
          digest: hash,
          assets,
          origin: base,
          trustProfile: 'trusted-local-content',
        });
        installed.set(id, { snapshot, root: base });
        snapshots.push(snapshot);
      }
      return ok(snapshots);
    },
    async read(snapshot, path, context) {
      if (context.signal.aborted) return fail('package.cancelled', 'Read cancelled', 'cancelled');
      const item = installed.get(snapshot.id);
      if (
        !item ||
        item.snapshot.digest !== snapshot.digest ||
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((p) => p === '..' || p === '.' || !p)
      )
        return fail('package.path', 'Unknown snapshot or invalid package path', 'permission');
      const asset = item.snapshot.assets.find((a) => a.path === path);
      if (!asset) return fail('package.asset', 'Asset not in snapshot');
      try {
        const file = resolve(item.root, path);
        if (
          (await lstat(file)).isSymbolicLink() ||
          relative(item.root, await realpath(file)) !== path
        )
          return fail('package.symlink', 'Asset path changed', 'permission');
        const bytes = await readFile(file);
        return (await digest(bytes)) === asset.digest
          ? ok(Uint8Array.from(bytes))
          : fail('package.digest', 'Package content changed', 'conflict');
      } catch {
        return fail('package.read', 'Package asset unavailable', 'unavailable');
      }
    },
  };
}
