import {
  fail,
  isJson,
  isJsonObject,
  jsonSchema,
  ok,
  schema,
} from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import { installTool } from '@slop-lab/part/tools.js';
import { isAbsolute } from 'node:path';
import { createDimRunner } from './dim-runner.js';

const actionValues = ['read', 'exec', 'start', 'stop'] as const;
export type DimAction = (typeof actionValues)[number];
export type DimToolsOptions = {
  readonly executable: string;
  readonly executableArgs?: readonly string[];
  readonly workspace: string;
  readonly allowedActions?: readonly DimAction[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};
export type DimToolRegistration = {
  readonly tools: readonly Tools.InstalledTool[];
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>;
  readonly toolIds: {
    readonly show?: string;
    readonly exec?: string;
    readonly start?: string;
    readonly stop?: string;
  };
};
type DimDefinition<I extends Contracts.Json> = {
  readonly key: 'show' | 'exec' | 'start' | 'stop';
  readonly id: string;
  readonly effects: 'read' | 'external';
  readonly input: Contracts.Schema<I>;
  readonly inputSchema: Contracts.Json;
  readonly argumentsFor: (value: I) => readonly string[];
  readonly jsonOutput: boolean;
};

export function createDimTools(options: DimToolsOptions): DimToolRegistration {
  if (!isAbsolute(options.executable) || options.executable.includes('\0'))
    throw new TypeError('DIM executable must be an absolute safe path');
  if (!options.workspace || options.workspace.includes('\0'))
    throw new TypeError('DIM workspace must be a fixed non-empty name');
  const executableArgs = options.executableArgs ?? [];
  if (executableArgs.some((argument) => argument.includes('\0')))
    throw new TypeError('DIM executable arguments must not contain NUL');
  const selected: readonly DimAction[] = options.allowedActions ?? ['read', 'exec'];
  const allowed = new Set(selected);
  if (allowed.size !== selected.length)
    throw new TypeError('DIM allowedActions contains duplicates');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('DIM timeout must be a positive integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new TypeError('DIM output limit must be a positive integer');
  const runDim = createDimRunner({
    executable: options.executable,
    executableArgs,
    timeoutMs,
    maxOutputBytes,
  });

  const tools: Tools.InstalledTool[] = [];
  const toolSchemas: Record<string, Contracts.Json> = {};
  const toolIds: { show?: string; exec?: string; start?: string; stop?: string } = {};
  const install = <I extends Contracts.Json>(definition: DimDefinition<I>) => {
    toolIds[definition.key] = definition.id;
    toolSchemas[definition.id] = definition.inputSchema;
    tools.push(
      installTool({
        definition: {
          id: definition.id,
          version: '1',
          description: `Run DIM workspace ${definition.key} for the configured workspace`,
          input: definition.input,
          output: jsonSchema,
          executor: 'part/function',
          effects: definition.effects,
          cancellation: 'terminable',
          retrySafety: definition.effects === 'read' ? 'read-only' : 'never',
          requiredCapabilities: [],
          timeoutMs,
        },
        execute: async (value, context) => {
          const result = await runDim(definition.argumentsFor(value), definition.effects, context);
          if (!result.ok) return result;
          if (result.value.exitCode !== 0)
            return {
              ok: false,
              error: {
                code: 'part.dim.exit',
                category: 'internal',
                message: `DIM exited with status ${result.value.exitCode}`,
                retry: 'never',
                effect: definition.effects === 'read' ? 'not-applied' : 'unknown',
                details: { ...result.value },
              },
            };
          let output: Contracts.Json = { ...result.value };
          if (definition.jsonOutput) {
            try {
              const parsed: unknown = JSON.parse(result.value.stdout);
              if (!isJson(parsed))
                return fail('dim.output', 'DIM JSON output is invalid', 'internal');
              output = parsed;
            } catch (error) {
              return fail(
                'dim.output',
                error instanceof Error ? 'DIM did not return JSON' : 'DIM output parsing failed',
                'internal',
                definition.effects === 'read' ? 'not-applied' : 'unknown',
              );
            }
          }
          return ok({ value: output, content: [], artifacts: [], diagnostics: [] });
        },
      }),
    );
  };

  if (allowed.has('read'))
    install({
      key: 'show',
      id: 'dim_workspace_show',
      effects: 'read',
      input: emptyInput,
      inputSchema: emptySchema,
      argumentsFor: () => ['workspace', 'show', options.workspace, '--json'],
      jsonOutput: true,
    });
  if (allowed.has('exec'))
    install({
      key: 'exec',
      id: 'dim_workspace_exec',
      effects: 'external',
      input: execInput,
      inputSchema: execSchema,
      argumentsFor: (value) => ['workspace', 'exec', options.workspace, '--', ...value.argv],
      jsonOutput: false,
    });
  if (allowed.has('start'))
    install({
      key: 'start',
      id: 'dim_workspace_start',
      effects: 'external',
      input: emptyInput,
      inputSchema: emptySchema,
      argumentsFor: () => ['workspace', 'start', options.workspace, '--json'],
      jsonOutput: true,
    });
  if (allowed.has('stop'))
    install({
      key: 'stop',
      id: 'dim_workspace_stop',
      effects: 'external',
      input: emptyInput,
      inputSchema: emptySchema,
      argumentsFor: () => ['workspace', 'stop', options.workspace, '--json'],
      jsonOutput: true,
    });
  return { tools, toolSchemas, toolIds };
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const;
const emptyInput = schema<Readonly<Record<string, Contracts.Json>>>(
  'part/dim/empty',
  (value): value is Readonly<Record<string, Contracts.Json>> =>
    isJsonObject(value) && Object.keys(value).length === 0,
);
const execSchema = {
  type: 'object',
  properties: {
    argv: { type: 'array', items: { type: 'string' }, maxItems: 256 },
  },
  required: ['argv'],
  additionalProperties: false,
} as const;
const execInput = schema<{ readonly argv: readonly string[] }>(
  'part/dim/exec',
  (value): value is { readonly argv: readonly string[] } =>
    isJsonObject(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.argv) &&
    value.argv.length <= 256 &&
    value.argv.every((argument) => typeof argument === 'string' && !argument.includes('\0')),
);
