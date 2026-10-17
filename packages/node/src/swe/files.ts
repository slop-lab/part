import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertWorkspacePath, workspaceRelativePath } from './files-paths.js';
import { WorkspaceFileError } from './files-error.js';
import { atomicWrite, BoundedFileError, readUtf8Bounded, withPathMutation } from './files-io.js';
import {
  contentDigest,
  hashedLines,
  shortLineHash,
  type HashedLine,
  type HashEdit,
} from './hash.js';

export { WorkspaceFileError } from './files-error.js';
export type { HashEdit } from './hash.js';

export type WorkspaceLimits = {
  readonly maxFileBytes: number;
  readonly maxOutputChars: number;
  readonly maxEntries: number;
};
export type FileProvenance = {
  readonly root: string;
  readonly path: string;
  readonly digest: string;
};
export type FileResult = {
  readonly path: string;
  readonly digest: string;
  readonly provenance: FileProvenance;
};
export type ReadResult = FileResult & {
  readonly content: string;
  readonly lines: readonly HashedLine[];
  readonly truncated: boolean;
};
export type ListResult = {
  readonly entries: readonly { readonly path: string; readonly kind: 'file' | 'directory' }[];
  readonly truncated: boolean;
};
export type SearchResult = {
  readonly matches: readonly {
    readonly path: string;
    readonly line: number;
    readonly hash: string;
    readonly text: string;
  }[];
  readonly truncated: boolean;
};
/**
 * Confines paths and performs optimistic writes. This is for a trusted workspace process,
 * not hostile concurrent filesystem actors: digest checks and rename are not an OS-level CAS,
 * and hostile hard-link insertion must be prevented by the workspace owner.
 */
export class WorkspaceFiles {
  readonly #root: string;
  constructor(
    root: string,
    readonly limits: WorkspaceLimits,
  ) {
    this.#root = resolve(root);
  }

  async read(path: string): Promise<ReadResult> {
    const target = await this.#existing(path);
    const content = await this.#readBounded(target.absolute);
    return this.#readResult(target.relative, content);
  }

  async list(path: string, recursive = true): Promise<ListResult> {
    const target = await this.#existing(path);
    const entries: { path: string; kind: 'file' | 'directory' }[] = [];
    let truncated = false;
    const visit = async (absolute: string, base: string): Promise<void> => {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entries.length >= this.limits.maxEntries) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const entryPath = base === '.' ? entry.name : `${base}/${entry.name}`;
        if (entry.isDirectory()) {
          entries.push({ path: entryPath, kind: 'directory' });
          if (recursive) await visit(resolve(absolute, entry.name), entryPath);
        } else if (entry.isFile()) entries.push({ path: entryPath, kind: 'file' });
        if (truncated) return;
      }
    };
    const stat = await lstat(target.absolute);
    if (!stat.isDirectory()) throw new WorkspaceFileError('workspace.not-directory', path);
    await visit(target.absolute, target.relative);
    return { entries, truncated };
  }

  async search(path: string, query: string): Promise<SearchResult> {
    if (!query) throw new WorkspaceFileError('workspace.query', 'Search query must not be empty');
    const listed = await this.list(path, true);
    const matches: { path: string; line: number; hash: string; text: string }[] = [];
    let chars = 0,
      truncated = listed.truncated;
    for (const entry of listed.entries) {
      if (entry.kind !== 'file') continue;
      let content: string;
      try {
        content = await this.#readBounded((await this.#existing(entry.path)).absolute);
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.code === 'workspace.too-large') continue;
        throw error;
      }
      for (const line of hashedLines(content)) {
        if (!line.text.includes(query)) continue;
        const size = entry.path.length + line.text.length;
        if (matches.length >= this.limits.maxEntries || chars + size > this.limits.maxOutputChars) {
          truncated = true;
          return { matches, truncated };
        }
        matches.push({ path: entry.path, line: line.line, hash: line.hash, text: line.text });
        chars += size;
      }
    }
    return { matches, truncated };
  }

  async write(input: {
    readonly path: string;
    readonly content: string;
    readonly expectedDigest?: string;
    readonly absent?: boolean;
  }): Promise<FileResult> {
    if ((input.expectedDigest === undefined) === (input.absent !== true))
      throw new WorkspaceFileError(
        'workspace.precondition',
        'Provide exactly one of expectedDigest or absent: true',
      );
    if (Buffer.byteLength(input.content) > this.limits.maxFileBytes)
      throw new WorkspaceFileError('workspace.too-large', 'File exceeds configured limit');
    const candidate = await this.#writable(input.path);
    return withPathMutation(candidate.absolute, async () => {
      const target = await this.#writable(input.path);
      const exists = await this.#exists(target.absolute);
      if (input.absent === true) {
        if (exists) throw new WorkspaceFileError('workspace.exists', 'Expected path to be absent');
      } else {
        const current = await this.#readBounded(target.absolute);
        if (contentDigest(current) !== input.expectedDigest)
          throw new WorkspaceFileError('workspace.stale', 'File digest no longer matches');
      }
      await atomicWrite(target.absolute, input.content, exists);
      return this.#fileResult(target.relative, input.content);
    });
  }

  async editHash(input: {
    readonly path: string;
    readonly expectedDigest: string;
    readonly edits: readonly HashEdit[];
  }): Promise<FileResult> {
    return this.#edit(input.path, input.expectedDigest, (content) => {
      const lines = content.split('\n');
      const seen = new Set<number>();
      for (const edit of input.edits) {
        const text = lines[edit.line - 1];
        if (text === undefined || seen.has(edit.line) || shortLineHash(text) !== edit.hash)
          throw new WorkspaceFileError(
            'workspace.stale-line',
            `Line ${edit.line} no longer matches`,
          );
        seen.add(edit.line);
      }
      for (const edit of input.edits) lines[edit.line - 1] = edit.newText;
      return lines.join('\n');
    });
  }

  async editExact(input: {
    readonly path: string;
    readonly expectedDigest: string;
    readonly oldText: string;
    readonly newText: string;
  }): Promise<FileResult> {
    return this.#edit(input.path, input.expectedDigest, (content) => {
      const first = content.indexOf(input.oldText);
      if (!input.oldText || first < 0 || content.indexOf(input.oldText, first + 1) >= 0)
        throw new WorkspaceFileError('workspace.non-unique', 'oldText must occur exactly once');
      return `${content.slice(0, first)}${input.newText}${content.slice(first + input.oldText.length)}`;
    });
  }

  async #existing(path: string): Promise<{ readonly absolute: string; readonly relative: string }> {
    const relativePath = workspaceRelativePath(path);
    const root = await realpath(this.#root);
    const absolute = await realpath(resolve(root, relativePath));
    assertWorkspacePath(root, absolute);
    return { absolute, relative: relativePath };
  }

  async #writable(path: string): Promise<{ readonly absolute: string; readonly relative: string }> {
    const relativePath = workspaceRelativePath(path);
    const root = await realpath(this.#root);
    const candidate = resolve(root, relativePath);
    const parent = await realpath(resolve(candidate, '..'));
    assertWorkspacePath(root, parent);
    if (await this.#exists(candidate)) {
      if ((await lstat(candidate)).isSymbolicLink())
        throw new WorkspaceFileError('workspace.symlink', 'Writable path must not be a symlink');
      assertWorkspacePath(root, await realpath(candidate));
    }
    return { absolute: candidate, relative: relativePath };
  }

  async #readBounded(path: string): Promise<string> {
    try {
      return await readUtf8Bounded(path, this.limits.maxFileBytes);
    } catch (error) {
      if (error instanceof BoundedFileError)
        throw new WorkspaceFileError(
          error.kind === 'too-large' ? 'workspace.too-large' : 'workspace.binary',
          error.kind === 'too-large' ? 'File exceeds configured limit' : 'File is not valid UTF-8',
        );
      throw error;
    }
  }

  async #readFull(path: string): Promise<{ path: string; content: string; digest: string }> {
    const target = await this.#existing(path);
    const content = await this.#readBounded(target.absolute);
    return { path: target.relative, content, digest: contentDigest(content) };
  }

  #readResult(path: string, content: string): ReadResult {
    const truncated = content.length > this.limits.maxOutputChars;
    const visible = truncated ? content.slice(0, this.limits.maxOutputChars) : content;
    return {
      ...this.#fileResult(path, content),
      content: visible,
      lines: hashedLines(visible),
      truncated,
    };
  }

  #fileResult(path: string, content: string): FileResult {
    const digest = contentDigest(content);
    return { path, digest, provenance: { root: 'workspace', path, digest } };
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async #edit(
    path: string,
    expectedDigest: string,
    transform: (content: string) => string,
  ): Promise<FileResult> {
    const candidate = await this.#writable(path);
    return withPathMutation(candidate.absolute, async () => {
      const current = await this.#readFull(path);
      if (current.digest !== expectedDigest)
        throw new WorkspaceFileError('workspace.stale', 'File digest no longer matches');
      const content = transform(current.content);
      if (Buffer.byteLength(content) > this.limits.maxFileBytes)
        throw new WorkspaceFileError('workspace.too-large', 'File exceeds configured limit');
      await atomicWrite(candidate.absolute, content, true);
      return this.#fileResult(current.path, content);
    });
  }
}
