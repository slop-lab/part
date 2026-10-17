import { isJsonObject, schema } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Storage } from '@slop-lab/part/reference/index.js';
import { isAbsolute, resolve } from 'node:path';

export type ProcessState = 'running' | 'exited' | 'failed' | 'cancelled' | 'timed_out';
export type RunnerMetadata = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly error?: string;
};
export type ProcessRecord = {
  readonly id: string;
  readonly directory: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly metaPath: string;
  readonly controller: AbortController;
  state: ProcessState;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  termination?: 'cancelled' | 'timed_out';
  artifact?: Contracts.ArtifactRef;
  artifactError?: string;
  unresolvedPid?: number;
  cleanupError?: Contracts.Failure;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
};
export class ProcessToolError extends Error {
  readonly name = 'ProcessToolError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type ProcessCommandBinding =
  string | { readonly command: string; readonly args: readonly string[] };
export interface ProcessToolsOptions {
  readonly root: string;
  readonly artifacts?: Storage.ArtifactStore;
  readonly commands?: Readonly<Record<string, ProcessCommandBinding>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly allowShell?: boolean;
  readonly maxOutputBytes?: number;
  readonly maxInlineBytes?: number;
  readonly maxProcesses?: number;
}
export type StartInput = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly shell?: boolean;
};
export type IdInput = { readonly processId: string };
export type ReadInput = IdInput & {
  readonly stream?: 'stdout' | 'stderr';
  readonly offset?: number;
  readonly limit?: number;
};

const processEnvironment = (value: unknown): value is Readonly<Record<string, string>> =>
  isJsonObject(value) &&
  Object.entries(value).every(
    ([name, entry]) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === 'string' && !entry.includes('\0'),
  );
const only = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function positiveOption(value: number | undefined, fallback: number, name: string) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new TypeError(`Invalid ${name}`);
  return selected;
}
export function parseProcessOptions(options: ProcessToolsOptions) {
  if (!isAbsolute(options.root)) throw new TypeError('Process root must be absolute');
  const configured = structuredClone(options.commands ?? {});
  if (
    Object.entries(configured).some(([alias, binding]) => {
      const command = typeof binding === 'string' ? binding : binding.command;
      return (
        !/^[A-Za-z0-9._-]+$/.test(alias) ||
        command.includes('\0') ||
        !isAbsolute(command) ||
        (typeof binding !== 'string' &&
          (!Array.isArray(binding.args) ||
            binding.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))))
      );
    })
  )
    throw new TypeError('Invalid process command alias');
  const commands = Object.fromEntries(
    Object.entries(configured).map(([alias, binding]) => [
      alias,
      typeof binding === 'string' ? { command: binding, args: [] } : binding,
    ]),
  );
  const environment = structuredClone(options.environment ?? {});
  if (!processEnvironment(environment)) throw new TypeError('Invalid process environment');
  return {
    root: resolve(options.root),
    commands,
    environment,
    maxOutputBytes: positiveOption(options.maxOutputBytes, 1024 * 1024, 'output limit'),
    maxInlineBytes: positiveOption(options.maxInlineBytes, 16 * 1024, 'inline limit'),
    maxProcesses: positiveOption(options.maxProcesses, 64, 'process limit'),
  };
}
export function parseRunnerMetadata(value: unknown): RunnerMetadata | undefined {
  if (!isJsonObject(value)) return undefined;
  return (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    (value.signal === null || typeof value.signal === 'string') &&
    typeof value.truncated === 'boolean' &&
    Number.isSafeInteger(value.bytes)
    ? {
        exitCode: value.exitCode === null ? null : Number(value.exitCode),
        signal: value.signal === null ? null : String(value.signal),
        truncated: value.truncated,
        bytes: Number(value.bytes),
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
      }
    : undefined;
}

export function startSchema(allowShell: boolean, aliases: readonly string[]) {
  const configured = new Set(aliases);
  return schema<StartInput>('part/swe/process-start', (value): value is StartInput => {
    if (
      !isJsonObject(value) ||
      !only(value, ['command', 'args', 'cwd', 'env', 'timeoutMs', 'shell']) ||
      typeof value.command !== 'string' ||
      value.command.includes('\0') ||
      (!isAbsolute(value.command) && !configured.has(value.command)) ||
      (value.args !== undefined &&
        (!Array.isArray(value.args) ||
          value.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) ||
      (value.cwd !== undefined && (typeof value.cwd !== 'string' || value.cwd.includes('\0'))) ||
      (value.env !== undefined && !processEnvironment(value.env)) ||
      (value.timeoutMs !== undefined &&
        (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1)) ||
      (value.shell !== undefined && typeof value.shell !== 'boolean') ||
      (value.shell === true && (!allowShell || configured.has(value.command)))
    )
      return false;
    return true;
  });
}
export const idSchema = schema<IdInput>('part/swe/process-id', (value): value is IdInput =>
  Boolean(
    isJsonObject(value) &&
    only(value, ['processId']) &&
    typeof value.processId === 'string' &&
    /^[0-9a-f-]{36}$/.test(value.processId),
  ),
);
export function readSchema() {
  return schema<ReadInput>('part/swe/process-read', (value): value is ReadInput => {
    if (
      !isJsonObject(value) ||
      !only(value, ['processId', 'stream', 'offset', 'limit']) ||
      typeof value.processId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.processId) ||
      (value.stream !== undefined && value.stream !== 'stdout' && value.stream !== 'stderr') ||
      (value.offset !== undefined &&
        (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0)) ||
      (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1))
    )
      return false;
    return true;
  });
}
const idToolSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['processId'],
  properties: { processId: { type: 'string' } },
} as const;
export function processToolSchemas(
  aliases: readonly string[],
): Readonly<Record<string, Contracts.Json>> {
  const startToolSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: {
      command: {
        type: 'string',
        description: aliases.length
          ? `Absolute executable path or configured alias: ${aliases.join(', ')}`
          : 'Absolute executable path',
      },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      timeoutMs: { type: 'integer', minimum: 1 },
      shell: { type: 'boolean' },
    },
  } as const;
  return {
    swe_exec: startToolSchema,
    swe_process_start: startToolSchema,
    swe_process_status: idToolSchema,
    swe_process_wait: idToolSchema,
    swe_process_read: {
      type: 'object',
      additionalProperties: false,
      required: ['processId'],
      properties: {
        processId: { type: 'string' },
        stream: { enum: ['stdout', 'stderr'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
    },
    swe_process_cancel: idToolSchema,
  };
}
