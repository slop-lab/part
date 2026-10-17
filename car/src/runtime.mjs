// @ts-check
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHistory } from '@slop-lab/part/context/history.js';
import { isJson, localContext } from '@slop-lab/part/contracts/index.js';
import { createExecutionRecovery, createStoredBoundary } from '@slop-lab/part/storage/runtime.js';
import { openFileArtifacts } from '@slop-lab/part-node/artifacts.js';
import { openSqliteStore } from '@slop-lab/part-node/storage/sqlite.js';
import { createWorkspaceTools } from '@slop-lab/part-node/swe/workspace.js';
import { createProcessTools } from '@slop-lab/part-node/swe/process.js';
import { createMockProviderTools } from '@slop-lab/part-node/testing/mock-provider/tools.js';
import { createCarAgent } from './agent.mjs';
import { createArchive } from './archive.mjs';
import { createConversation } from './conversation.mjs';
import { createCarEndpoint } from './endpoint.mjs';
import { createWorkspaceView } from './workspace-view.mjs';
import { createCarWorkflowSurface } from './workflow-surface.mjs';
import { createCompletionCheck } from './completion.mjs';
import { acquireState } from './state.mjs';
import { cleanupStages } from './cleanup.mjs';
import { resolveCommands } from './commands.mjs';

/** @import { Contracts } from '@slop-lab/part/reference/index.js' */
/** @typedef {{root: string, stateDirectory: string,
 * model: import('@slop-lab/part/reference/index.js').Convenience.ConfiguredModel,
 * context?: Contracts.InvocationContext, editMode?: 'hash'|'exact',
 * trace?: 'metadata'|'full', allowShell?: boolean,
 * limits?: import('@slop-lab/part/reference/index.js').Runtime.ExecutionLimits,
 * middleware?: readonly import('@slop-lab/part/reference/index.js').Tools.Middleware[],
 * validate?: import('@slop-lab/part-plugins/swe/coding.js').CodingDriverOptions['validate'],
 * completionCommand?: readonly string[],
 * operator?: import('@slop-lab/part-node/testing/mock-provider/types.js').MockProviderClient,
 * external?: {tools: readonly import('@slop-lab/part/reference/index.js').Tools.InstalledTool[],
 * toolSchemas: Readonly<Record<string, Contracts.Json>>,
 * executors?: readonly import('@slop-lab/part/reference/index.js').Tools.Executor[]},
 * workflows?: boolean | import('./workflow-surface.mjs').WorkflowOptions,
 * workspaceProvider?: 'local'|'external'}} CarOptions */

/** Explicit single-workspace, single-writer CAR runtime. @param {CarOptions} options */
export async function openCar(options) {
  const root = await realpath(options.root);
  const stateDirectory = resolve(options.stateDirectory);
  const context =
    options.context ??
    localContext({ principal: { subject: 'developer', authority: 'car/local' } });
  const state = await acquireState(stateDirectory, root);
  /** @type {import('@slop-lab/part/storage/memory.js').LocalStore | undefined} */
  let ownedStore;
  /** @type {ReturnType<typeof createProcessTools> | undefined} */
  let ownedProcesses;
  /** @type {import('./conversation.mjs').Agent | undefined} */
  let agent;
  /** @type {Awaited<ReturnType<typeof createCarEndpoint>> | undefined} */
  let ownedSurface;
  /** @type {ReturnType<typeof createArchive> | undefined} */
  let ownedArchive;
  /** @type {Promise<Contracts.CleanupReport> | undefined} */
  let closing;
  const close = () =>
    (closing ??= (async () => {
      const report = await cleanupStages([
        {
          name: 'execution',
          close: () => (ownedSurface ? ownedSurface.close() : agent?.dispose()),
        },
        { name: 'processes', close: () => ownedProcesses?.close() },
        {
          name: 'archive',
          async close() {
            const flushed = await ownedArchive?.flush();
            return {
              released: [],
              unresolved: [],
              errors: flushed && !flushed.ok ? [flushed.error] : [],
            };
          },
        },
        { name: 'storage', close: () => ownedStore?.close() },
      ]);
      const lockReport = await cleanupStages([
        { name: 'state-lock', close: () => state.release(report) },
      ]);
      return {
        released: [...report.released, ...lockReport.released],
        unresolved: [...report.unresolved, ...lockReport.unresolved],
        errors: [...report.errors, ...lockReport.errors],
      };
    })());
  try {
    const opened = openSqliteStore(join(stateDirectory, 'car.sqlite'));
    if (!opened.ok) throw new Error(opened.error.message);
    const store = (ownedStore = opened.value);
    const artifacts = await openFileArtifacts(join(stateDirectory, 'artifacts'));
    const commandPolicy = await resolveCommands(stateDirectory);
    const processes = (ownedProcesses = createProcessTools({
      root,
      artifacts,
      ...commandPolicy,
      allowShell: options.allowShell ?? false,
    }));
    const archive = createArchive(store, context);
    ownedArchive = archive;
    const bound = await archive.get('root');
    if (!bound.ok) throw new Error(bound.error.message);
    if (bound.value && bound.value.value.value !== root)
      throw new Error('CAR state belongs to another workspace');
    if (!bound.value) {
      const written = await archive.set('root', root);
      if (!written.ok) throw new Error(written.error.message);
    }
    const recovery = await createExecutionRecovery(store).recover(context);
    if (!recovery.ok) throw new Error(recovery.error.message);
    const workspace =
      options.workspaceProvider === 'external'
        ? { tools: [], toolSchemas: {} }
        : createWorkspaceTools({ root, editMode: options.editMode ?? 'hash' });
    const operator = options.operator
      ? createMockProviderTools(options.operator)
      : { tools: [], toolSchemas: {} };
    const tools = [
      ...workspace.tools,
      ...processes.tools,
      ...operator.tools,
      ...(options.external?.tools ?? []),
    ];
    const toolSchemas = {
      ...workspace.toolSchemas,
      ...processes.toolSchemas,
      ...operator.toolSchemas,
      ...options.external?.toolSchemas,
    };
    const limits = {
      maxModelInvocations: 32,
      maxToolDispatches: 64,
      maxChildRuns: 4,
      maxExecutorAttempts: 96,
      ...options.limits,
    };
    const model = {
      ...options.model,
      transport: {
        ...options.model.transport,
        /** @type {import('@slop-lab/part/reference/index.js').Model.Transport['send']} */
        send(request, profile, auth, invocation) {
          if (options.trace === 'full')
            archive.record('request-body', {
              digest: request.digest,
              endpoint: profile.endpoint ?? 'local',
              body: new TextDecoder().decode(request.body),
              boundary: request.inspectionBoundary,
            });
          return options.model.transport.send(request, profile, auth, invocation);
        },
      },
    };
    const configured = createCarAgent({
      model,
      tools,
      toolSchemas,
      boundary: createStoredBoundary(store),
      limits,
      principal: context.principal,
      middleware: options.middleware,
      executors: options.external?.executors,
      validate:
        options.validate ??
        (options.completionCommand
          ? createCompletionCheck({
              argv: options.completionCommand,
              tools: processes.tools,
              boundary: createStoredBoundary(store),
            })
          : undefined),
      subagents: {
        allowedToolIds: [
          'swe_read',
          'swe_list',
          'swe_search',
          ...operator.tools.map((tool) => tool.id),
        ].filter((id) => tools.some((tool) => tool.id === id)),
      },
      inspectContext(compiled) {
        archive.record(
          'context',
          options.trace === 'full'
            ? compiled
            : {
                id: compiled.id,
                digest: compiled.digest,
                sourceVersions: compiled.sourceVersions,
                decisions: compiled.decisions,
                losses: compiled.losses,
              },
        );
      },
      inspectRequest(view) {
        archive.record('request', view);
      },
    });
    if (!configured.ok) throw new Error(configured.error.message);
    agent = configured.value;
    const history = createHistory({ store });
    agent = await createConversation({ agent: configured.value, history, archive, context });
    const config = {
      product: 'car',
      root,
      stateDirectory,
      editMode: options.editMode ?? 'hash',
      workspaceProvider: options.workspaceProvider ?? 'local',
      trace: options.trace ?? 'metadata',
      model: options.model.profile.model,
      profileId: options.model.profile.id,
      limits,
      commands: commandPolicy.commands,
      tools: tools.map((tool) => ({ id: tool.id, version: tool.version })),
      guarantees: {
        history: 'durable',
        checkpoint: 'none',
        effects: 'runner-path-only',
        commandDedupe: 'memory',
        processOwner: 'car-runtime',
      },
    };
    if (!isJson(config)) throw new TypeError('Invalid CAR configuration');
    const surface = await createCarEndpoint({
      agent,
      archive,
      context,
      artifacts,
      config,
      history,
      workspace: createWorkspaceView(root),
    });
    ownedSurface = surface;
    if (options.workflows) {
      const execution = await configured.value.executionServices();
      if (!execution.ok) throw new Error(execution.error.message);
      const workflow = await createCarWorkflowSurface({
        root,
        execution: execution.value,
        boundary: createStoredBoundary(store),
        hub: surface.hub,
        limits,
        ...(typeof options.workflows === 'object' ? { options: options.workflows } : {}),
      });
      if (!workflow.ok) throw new Error(workflow.error.message);
      surface.attachWorkflows(workflow.value);
    }
    return {
      agent,
      endpoint: surface.endpoint,
      hub: surface.hub,
      archive,
      recovery: recovery.value,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
