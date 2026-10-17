import { isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { FileResult, ListResult, ReadResult, SearchResult } from './files.js';

const digestPattern = /^[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{8}$/;

export function isWorkspaceFileResult(value: unknown): value is FileResult {
  if (
    !isJsonObject(value) ||
    typeof value['path'] !== 'string' ||
    typeof value['digest'] !== 'string' ||
    !digestPattern.test(value['digest']) ||
    !isJsonObject(value['provenance'])
  )
    return false;
  const provenance = value['provenance'];
  return (
    typeof provenance['root'] === 'string' &&
    provenance['path'] === value['path'] &&
    provenance['digest'] === value['digest']
  );
}

export function isWorkspaceReadResult(value: unknown): value is ReadResult {
  return (
    isJsonObject(value) &&
    typeof value['content'] === 'string' &&
    typeof value['truncated'] === 'boolean' &&
    Array.isArray(value['lines']) &&
    value['lines'].every(isHashedLine) &&
    isWorkspaceFileResult(value)
  );
}

export function isWorkspaceListResult(value: unknown): value is ListResult {
  return (
    isJsonObject(value) &&
    typeof value['truncated'] === 'boolean' &&
    Array.isArray(value['entries']) &&
    value['entries'].every(
      (entry) =>
        isJsonObject(entry) &&
        typeof entry['path'] === 'string' &&
        (entry['kind'] === 'file' || entry['kind'] === 'directory'),
    )
  );
}

export function isWorkspaceSearchResult(value: unknown): value is SearchResult {
  return (
    isJsonObject(value) &&
    typeof value['truncated'] === 'boolean' &&
    Array.isArray(value['matches']) &&
    value['matches'].every(
      (match) =>
        isJsonObject(match) &&
        typeof match['path'] === 'string' &&
        Number.isSafeInteger(match['line']) &&
        typeof match['line'] === 'number' &&
        match['line'] > 0 &&
        typeof match['hash'] === 'string' &&
        hashPattern.test(match['hash']) &&
        typeof match['text'] === 'string',
    )
  );
}

function isHashedLine(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Number.isSafeInteger(value['line']) &&
    typeof value['line'] === 'number' &&
    value['line'] > 0 &&
    typeof value['hash'] === 'string' &&
    hashPattern.test(value['hash']) &&
    typeof value['text'] === 'string'
  );
}
