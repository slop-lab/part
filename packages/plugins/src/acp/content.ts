import { isJsonObject } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';
import { AcpError } from './types.js';
import type { AcpMcpServer } from './types.js';

export function promptContent(value: Contracts.Json, maxBytes: number): Model.ContentPart[] {
  if (!Array.isArray(value) || !value.length)
    throw new AcpError(-32602, 'Expected nonempty prompt content');
  const parts: Model.ContentPart[] = [];
  let bytes = 0;
  for (const block of value) {
    if (!isJsonObject(block)) throw new AcpError(-32602, 'Invalid prompt content');
    let text: string;
    if (block.type === 'text' && typeof block.text === 'string') text = block.text;
    else if (
      block.type === 'resource' &&
      isJsonObject(block.resource) &&
      typeof block.resource.uri === 'string' &&
      typeof block.resource.text === 'string'
    )
      text = `Resource: ${block.resource.uri}\n${block.resource.text}`;
    else throw new AcpError(-32602, 'Only text and embedded text resources are supported');
    bytes += new TextEncoder().encode(text).length;
    if (bytes > maxBytes) throw new AcpError(-32602, 'Prompt exceeds configured byte limit');
    parts.push({ kind: 'text', text });
  }
  if (!parts.some((part) => part.kind === 'text' && part.text.trim()))
    throw new AcpError(-32602, 'Prompt is empty');
  return parts;
}
export function sessionParams(
  params: Contracts.Json,
): Record<string, Contracts.Json> & { sessionId: string } {
  if (!isJsonObject(params) || typeof params.sessionId !== 'string' || !params.sessionId)
    throw new AcpError(-32602, 'A sessionId is required');
  return params as Record<string, Contracts.Json> & { sessionId: string };
}
export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647)
    throw new TypeError(`Invalid ${name}`);
  return limit;
}

export function mcpServers(value: Contracts.Json): AcpMcpServer[] {
  if (!Array.isArray(value) || value.length > 8)
    throw new AcpError(-32602, 'Expected at most eight MCP servers');
  const names = new Set<string>();
  return value.map((server) => {
    if (
      !isJsonObject(server) ||
      (server.type !== undefined && server.type !== 'stdio') ||
      typeof server.name !== 'string' ||
      !server.name ||
      names.has(server.name) ||
      typeof server.command !== 'string' ||
      !server.command ||
      !Array.isArray(server.args) ||
      !server.args.every((arg) => typeof arg === 'string') ||
      !Array.isArray(server.env) ||
      !server.env.every(
        (entry) =>
          isJsonObject(entry) && typeof entry.name === 'string' && typeof entry.value === 'string',
      )
    )
      throw new AcpError(-32602, 'Only valid, uniquely named stdio MCP servers are supported');
    names.add(server.name);
    return structuredClone(server) as unknown as AcpMcpServer;
  });
}
