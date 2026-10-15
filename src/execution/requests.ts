import { isJson, isJsonObject } from '../foundation/contracts.js';
import type { Scripts } from '../reference/index.js';
/** Structural validation can run during workflow preparation without launching a process. */
export function isScriptRequest(value: unknown): value is Scripts.Request {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'requestId',
          'executorId',
          'source',
          'interpreter',
          'args',
          'stdin',
          'workspace',
          'environmentProfile',
          'timeoutMs',
          'capture',
          'effects',
          'retry',
          'bridgeGrant',
        ].includes(k),
    ) ||
    !isJsonObject(value.source) ||
    !isJsonObject(value.capture)
  )
    return false;
  if (
    typeof value.requestId !== 'string' ||
    !value.requestId ||
    typeof value.executorId !== 'string' ||
    typeof value.interpreter !== 'string' ||
    !Array.isArray(value.args) ||
    value.args.some((a) => typeof a !== 'string') ||
    typeof value.source.relativePath !== 'string' ||
    !value.source.relativePath ||
    typeof value.source.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.source.digest)
  )
    return false;
  if (
    Object.keys(value.source).some((k) => !['packageId', 'relativePath', 'digest'].includes(k)) ||
    (value.source.packageId !== undefined && typeof value.source.packageId !== 'string')
  )
    return false;
  if (
    !['read', 'write', 'external', 'unknown'].includes(String(value.effects)) ||
    !['never', 'read-only', 'idempotent', 'reconcile'].includes(String(value.retry))
  )
    return false;
  if (
    (value.timeoutMs !== undefined &&
      (typeof value.timeoutMs !== 'number' ||
        !Number.isSafeInteger(value.timeoutMs) ||
        value.timeoutMs <= 0)) ||
    (value.environmentProfile !== undefined && typeof value.environmentProfile !== 'string') ||
    (value.bridgeGrant !== undefined && typeof value.bridgeGrant !== 'string')
  )
    return false;
  if (
    value.workspace !== undefined &&
    (!isJsonObject(value.workspace) ||
      ['id', 'kind', 'owner'].some(
        (k) => typeof (value.workspace as Record<string, unknown>)[k] !== 'string',
      ))
  )
    return false;
  const capture = value.capture;
  const fields: Record<string, string[]> = {
    none: [],
    'stdout-json': ['maxBytes'],
    file: ['relativePath', 'mediaType', 'maxBytes'],
    channel: ['channelId', 'protocolVersion', 'maxBytes'],
  };
  if (
    typeof capture.kind !== 'string' ||
    !Object.hasOwn(fields, capture.kind) ||
    Object.keys(capture).some((k) => !['kind', ...fields[capture.kind as string]!].includes(k))
  )
    return false;
  if (
    capture.kind !== 'none' &&
    (typeof capture.maxBytes !== 'number' ||
      !Number.isSafeInteger(capture.maxBytes) ||
      capture.maxBytes < 1)
  )
    return false;
  return (
    (capture.kind !== 'file' ||
      (typeof capture.relativePath === 'string' && typeof capture.mediaType === 'string')) &&
    (capture.kind !== 'channel' ||
      (typeof capture.channelId === 'string' && Number.isSafeInteger(capture.protocolVersion))) &&
    isJson(value)
  );
}
