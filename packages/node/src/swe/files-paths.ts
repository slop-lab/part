import { isAbsolute, relative, resolve, sep } from 'node:path';
import { WorkspaceFileError } from './files-error.js';

export function workspaceRelativePath(path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path))
    throw new WorkspaceFileError('workspace.path', 'Path must be workspace-relative');
  const normalized = relative('.', resolve('.', path)).split(sep).join('/');
  if (normalized === '..' || normalized.startsWith('../'))
    throw new WorkspaceFileError('workspace.escape', 'Path escapes workspace root');
  return normalized || '.';
}

export function assertWorkspacePath(root: string, target: string): void {
  const path = relative(root, target);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new WorkspaceFileError('workspace.escape', 'Resolved path escapes workspace root');
}
