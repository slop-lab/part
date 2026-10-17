import { createHash } from 'node:crypto';

export type HashedLine = {
  readonly line: number;
  readonly hash: string;
  readonly text: string;
};

export type HashEdit = {
  readonly line: number;
  readonly hash: string;
  readonly newText: string;
};

export function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function shortLineHash(text: string): string {
  return contentDigest(text).slice(0, 8);
}

export function hashedLines(content: string): readonly HashedLine[] {
  return content.split('\n').map((text, index) => ({
    line: index + 1,
    hash: shortLineHash(text),
    text,
  }));
}
