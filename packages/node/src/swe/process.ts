import { digest, fail, jsonSchema } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import { functionTool } from '@slop-lab/part/tools.js';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runScriptProcess } from '../scripts/process.js';
import { closeProcessRecords } from './process-cleanup.js';
import { processRunnerSource } from './process-runner.js';
import { processStatus, publishProcessArtifact, readProcessOutput } from './process-output.js';
import {
  idSchema,
  parseRunnerMetadata,
  parseProcessOptions,
  ProcessToolError,
  processToolSchemas,
  readSchema,
  startSchema,
  type IdInput,
  type ProcessRecord,
  type ProcessToolsOptions,
  type ReadInput,
  type RunnerMetadata,
  type StartInput,
} from './process-types.js';

export type { ProcessToolsOptions } from './process-types.js';

export function createProcessTools(options: ProcessToolsOptions): {
  readonly tools: readonly Tools.InstalledTool[];
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>;
  close(): Promise<Contracts.CleanupReport>;
} {
  const { root, commands, environment, maxOutputBytes, maxInlineBytes, maxProcesses } =
    parseProcessOptions(options);
  const aliases = Object.keys(commands).sort();
  const records = new Map<string, ProcessRecord>();
  let closed = false;
  let closing: Promise<Contracts.CleanupReport> | undefined;

  const get = (id: string) => {
    const record = records.get(id);
    if (!record) throw new ProcessToolError('swe.process.missing', `Unknown process ${id}`);
    return record;
  };
  const launch = async (
    input: StartInput,
    context: Tools.ExecutionContext,
    followParent: boolean,
  ): Promise<ProcessRecord> => {
    if (closed) throw new ProcessToolError('swe.process.closed', 'Process tools are closed');
    if ([...records.values()].filter((record) => record.state === 'running').length >= maxProcesses)
      throw new ProcessToolError('swe.process.capacity', 'Process capacity reached');
    const cwd = await realpath(resolve(root, input.cwd ?? '.'));
    const local = relative(await realpath(root), cwd);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new ProcessToolError('swe.process.cwd', 'Working directory is outside the root');
    const directory = await mkdtemp(join(tmpdir(), 'part-swe-process-'));
    const id = crypto.randomUUID();
    const artifactContext = { ...context, signal: new AbortController().signal };
    const record: ProcessRecord = {
      id,
      directory,
      stdoutPath: join(directory, 'stdout'),
      stderrPath: join(directory, 'stderr'),
      metaPath: join(directory, 'result.json'),
      controller: new AbortController(),
      state: 'running',
      exitCode: null,
      signal: null,
      truncated: false,
      done: Promise.resolve(),
    };
    await Promise.all([writeFile(record.stdoutPath, ''), writeFile(record.stderrPath, '')]);
    records.set(id, record);
    const cancelFromParent = () => {
      if (record.state === 'running') {
        record.termination = 'cancelled';
        record.controller.abort('parent-cancelled');
      }
    };
    if (followParent) {
      context.signal.addEventListener('abort', cancelFromParent, { once: true });
      if (context.signal.aborted) cancelFromParent();
    }
    const runner = new TextEncoder().encode(processRunnerSource);
    const binding = commands[input.command];
    const config = Buffer.from(
      JSON.stringify({
        command: binding?.command ?? input.command,
        args: [...(binding?.args ?? []), ...(input.args ?? [])],
        cwd,
        environment: { ...environment, ...(input.env ?? {}) },
        shell: input.shell ?? false,
        stdoutPath: record.stdoutPath,
        stderrPath: record.stderrPath,
        metaPath: record.metaPath,
        maxOutputBytes,
      }),
    ).toString('base64url');
    if (input.timeoutMs)
      record.timer = setTimeout(() => {
        if (record.state === 'running') {
          record.termination = 'timed_out';
          record.controller.abort('timeout');
        }
      }, input.timeoutMs);
    record.done = (async () => {
      let finalState: ProcessRecord['state'] = 'failed';
      try {
        const outcome = await runScriptProcess(
          {
            root,
            interpreters: { node: process.execPath },
            environments: { process: environment },
          },
          {
            request: {
              requestId: id,
              executorId: 'part/node-process',
              source: { relativePath: 'process-runner.cjs', digest: await digest(runner) },
              interpreter: 'node',
              args: [config],
              environmentProfile: 'process',
              capture: { kind: 'none' },
              effects: 'unknown',
              retry: 'never',
            },
            bytes: runner,
            workspace: root,
            executionDigest: await digest(config),
            context: { ...context, signal: record.controller.signal, wait: (pending) => pending },
            interpreters: { node: process.execPath },
            environments: { process: environment },
          },
        );
        if (outcome.unresolvedPid) {
          record.unresolvedPid = outcome.unresolvedPid;
          record.cleanupError =
            outcome.outcome.kind === 'failed'
              ? outcome.outcome.error
              : fail(
                  'scripts.process-tree',
                  'Process tree termination is unconfirmed',
                  'unavailable',
                ).error;
        }
        let result: RunnerMetadata | undefined;
        try {
          result = parseRunnerMetadata(JSON.parse(await readFile(record.metaPath, 'utf8')));
        } catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof Error)) throw error;
        }
        record.exitCode = result?.exitCode ?? null;
        record.signal = result?.signal ?? null;
        record.truncated = result?.truncated ?? false;
        finalState =
          record.termination ??
          (result && !result.error && outcome.outcome.kind === 'returned' ? 'exited' : 'failed');
      } catch (error) {
        record.cleanupError = fail(
          'swe.process-execution',
          error instanceof Error ? error.message : 'Process execution failed',
          'unavailable',
        ).error;
      } finally {
        clearTimeout(record.timer);
        context.signal.removeEventListener('abort', cancelFromParent);
        await publishProcessArtifact(record, options.artifacts, artifactContext);
        record.state = finalState;
      }
    })();
    return record;
  };
  const wait = async (record: ProcessRecord, signal: AbortSignal): Promise<Contracts.Json> => {
    if (signal.aborted) throw new ProcessToolError('swe.process.wait-cancelled', 'Wait cancelled');
    let cancelWait: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelWait = () =>
        reject(new ProcessToolError('swe.process.wait-cancelled', 'Wait cancelled'));
      signal.addEventListener('abort', cancelWait, { once: true });
    });
    try {
      await Promise.race([record.done, cancelled]);
      return processStatus(record);
    } finally {
      if (cancelWait) signal.removeEventListener('abort', cancelWait);
    }
  };
  const input = startSchema(options.allowShell ?? false, aliases);
  const tools = [
    functionTool({
      id: 'swe_exec',
      input,
      output: jsonSchema,
      effects: 'external',
      execute: async (value: StartInput, context) =>
        wait(await launch(value, context, true), context.signal),
    }),
    functionTool({
      id: 'swe_process_start',
      input,
      output: jsonSchema,
      effects: 'external',
      execute: async (value: StartInput, context) =>
        processStatus(await launch(value, context, false)),
    }),
    functionTool({
      id: 'swe_process_status',
      input: idSchema,
      output: jsonSchema,
      execute: (input: IdInput) => processStatus(get(input.processId)),
    }),
    functionTool({
      id: 'swe_process_wait',
      input: idSchema,
      output: jsonSchema,
      execute: (input: IdInput, context) => wait(get(input.processId), context.signal),
    }),
    functionTool({
      id: 'swe_process_read',
      input: readSchema(),
      output: jsonSchema,
      execute: (input: ReadInput) => readProcessOutput(get(input.processId), input, maxInlineBytes),
    }),
    functionTool({
      id: 'swe_process_cancel',
      input: idSchema,
      output: jsonSchema,
      effects: 'write',
      execute: async (input: IdInput) => {
        const record = get(input.processId);
        if (record.state === 'running') {
          record.termination = 'cancelled';
          record.controller.abort('cancelled');
          await record.done;
        }
        return processStatus(record);
      },
    }),
  ];
  return {
    tools,
    toolSchemas: processToolSchemas(aliases),
    close: () =>
      (closing ??= (async () => {
        closed = true;
        return closeProcessRecords(records);
      })()),
  };
}
