import { digest, fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import { createNodeScripts } from '../scripts/index.js';

export type DimProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};
type RunnerOptions = {
  readonly executable: string;
  readonly executableArgs: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export function createDimRunner(options: RunnerOptions) {
  const bytes = new TextEncoder().encode(wrapperSource(options));
  const sourceDigest = digest(bytes);
  const captureBytes = options.maxOutputBytes * 2 + 4096;
  const scripts = createNodeScripts({
    root: process.cwd(),
    interpreters: { node: process.execPath },
    maxOutputBytes: captureBytes,
    maxSourceBytes: bytes.byteLength,
    source: async (source) =>
      source.packageId === 'part/dim-runner'
        ? ok(bytes)
        : fail('dim.runner-source', 'Unknown DIM runner source', 'permission'),
  });
  return async (
    argv: readonly string[],
    effects: 'read' | 'external',
    context: Tools.ExecutionContext,
  ): Promise<Contracts.Result<DimProcessResult>> => {
    const started = await scripts.execute(
      {
        requestId: crypto.randomUUID(),
        executorId: 'part/node-process',
        source: {
          packageId: 'part/dim-runner',
          relativePath: 'dim-runner.cjs',
          digest: await sourceDigest,
        },
        interpreter: 'node',
        args: [...argv],
        effects,
        retry: effects === 'read' ? 'read-only' : 'never',
        timeoutMs: options.timeoutMs,
        capture: { kind: 'stdout-json', maxBytes: captureBytes },
      },
      context,
    );
    if (!started.ok) return started;
    const outcome = await started.value.done;
    if (outcome.phase !== 'completed')
      return {
        ok: false,
        error:
          'error' in outcome && outcome.error
            ? outcome.error
            : fail('dim.cancelled', 'DIM process was cancelled', 'cancelled', outcome.effect).error,
      };
    const captured = outcome.result.captured;
    if (
      outcome.result.exitCode !== 0 ||
      captured?.kind !== 'inline' ||
      !isJsonObject(captured.value) ||
      typeof captured.value.exitCode !== 'number' ||
      typeof captured.value.stdout !== 'string' ||
      typeof captured.value.stderr !== 'string'
    )
      return fail('dim.runner', 'Supervised DIM runner failed', 'unavailable', outcome.effect);
    return ok({
      exitCode: captured.value.exitCode,
      stdout: captured.value.stdout,
      stderr: captured.value.stderr,
    });
  };
}

function wrapperSource(options: RunnerOptions): string {
  return `'use strict';
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(options.executable)}, [...${JSON.stringify(options.executableArgs)}, ...process.argv.slice(2)], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const stdout = [], stderr = [];
let bytes = 0, returned = false;
const collect = target => chunk => { bytes += chunk.length; if (bytes > ${options.maxOutputBytes}) process.exit(70); target.push(chunk); };
const finish = (exitCode, spawnError = false) => { if (returned) return; returned = true; console.log(JSON.stringify({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), spawnError })); };
child.stdout.on('data', collect(stdout));
child.stderr.on('data', collect(stderr));
child.on('error', () => finish(1, true));
child.on('close', code => finish(code ?? 1));
`;
}
