// @ts-check
import { createEmbeddedEndpoint } from '@slop-lab/part/host/embedded.js';
import { fail, isJson, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import { cleanupStages } from './cleanup.mjs';

/** @import { Contracts } from '@slop-lab/part/reference/index.js' */
/** @param {{agent: import('./conversation.mjs').Agent,
 * archive: ReturnType<import('./archive.mjs').createArchive>,
 * context: Contracts.InvocationContext,
 * history: import('@slop-lab/part/context/history.js').HistoryService,
 * workspace: ReturnType<import('./workspace-view.mjs').createWorkspaceView>,
 * artifacts: import('@slop-lab/part/reference/index.js').Storage.ArtifactStore,
 * config: Contracts.Json}} options */
export async function createCarEndpoint(options) {
  const embedded = createEmbeddedEndpoint(options.agent, { context: options.context });
  if (!embedded.ok) throw new Error(embedded.error.message);
  const base = embedded.value;
  /** @type {(import('@slop-lab/part/reference/index.js').Client.Endpoint & {close(): Promise<Contracts.CleanupReport>}) | undefined} */
  let workflows;
  const previous = await options.archive.read('run-end', options.context);
  if (!previous.ok) throw new Error(previous.error.message);
  for (const [index, data] of previous.value.slice(-100).entries()) {
    if (!isJsonObject(data) || !isJsonObject(data.outcome)) continue;
    const outcome = data.outcome;
    const result = isJsonObject(outcome.result) ? outcome.result : undefined;
    const content = result && Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter(isJsonObject)
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('');
    base.hub.upsert({
      id: `car/history/${index}`,
      type: 'part/message',
      schemaVersion: 1,
      revision: '1',
      payload: { phase: outcome.phase ?? 'unknown', text },
      fallback: { label: 'Saved answer', text },
      actions: [],
      artifacts: [],
    });
  }
  /** @type {import('@slop-lab/part/reference/index.js').Client.Endpoint} */
  const endpoint = {
    command: (request, caller) =>
      workflows &&
      (request.actionId.startsWith('part.workflow/') || request.target?.kind === 'part/workflow')
        ? workflows.command(request, caller)
        : base.command(request, caller),
    watch: (request, caller) => base.watch(request, caller),
    async query(request, caller) {
      if (
        workflows &&
        (request.queryId.startsWith('part.workflow/') || request.target?.kind === 'part/workflow')
      )
        return workflows.query(request, caller);
      if (!request.queryId.startsWith('car.')) return base.query(request, caller);
      if (
        caller.principal.subject !== options.context.principal.subject ||
        caller.principal.authority !== options.context.principal.authority
      )
        return fail('car.permission', 'CAR inspector access denied', 'permission');
      if (request.version !== 1)
        return fail('car.version', 'Unsupported query version', 'unsupported');
      switch (request.queryId) {
        case 'car.config/get':
          return ok(options.config);
        case 'car.history/path': {
          const saved = await options.archive.get('session');
          if (!saved.ok) return saved;
          const id = saved.value?.value.value;
          if (typeof id !== 'string') return fail('car.session', 'Conversation is unavailable');
          const branch = await options.history.getBranch(id, caller);
          if (!branch.ok) return branch;
          const path = await options.history.path(branch.value, undefined, caller);
          if (!path.ok) return path;
          return ok(JSON.parse(JSON.stringify(path.value)));
        }
        case 'car.run/list':
          return options.archive.read('run-start', caller);
        case 'car.context/get':
          return options.archive.read('context', caller);
        case 'car.request/get': {
          const metadata = await options.archive.read('request', caller);
          if (!metadata.ok) return metadata;
          const bodies = await options.archive.read('request-body', caller);
          return bodies.ok ? ok({ metadata: metadata.value, bodies: bodies.value }) : bodies;
        }
        case 'car.events/get':
          return options.archive.read('progress', caller);
        case 'car.workspace/read': {
          const read = await options.workspace.read(request.input);
          if (!read.ok) return read;
          return ok({ ...read.value, lines: read.value.lines.map((line) => ({ ...line })) });
        }
        case 'car.workspace/diff':
          return options.workspace.diff(request.input, caller.signal);
        case 'car.artifact/read': {
          const input = request.input;
          if (
            !isJsonObject(input) ||
            typeof input.store !== 'string' ||
            typeof input.id !== 'string'
          )
            return fail('car.artifact', 'Expected artifact store and id');
          const result = await options.artifacts.read(
            { store: input.store, id: input.id },
            undefined,
            caller,
          );
          if (!result.ok) return result;
          const chunks = [];
          for await (const chunk of result.value) chunks.push(Buffer.from(chunk));
          return ok({ encoding: 'base64', bytes: Buffer.concat(chunks).toString('base64') });
        }
        case 'car.run/get': {
          if (typeof request.input !== 'string') return fail('car.run', 'Expected run id');
          const ended = await options.archive.read('run-end', caller);
          if (!ended.ok) return ended;
          const found = ended.value.find(
            (entry) =>
              isJsonObject(entry) && isJsonObject(entry.ref) && entry.ref.id === request.input,
          );
          if (found !== undefined && isJson(found)) return ok(found);
          const live = await base.query(
            { queryId: 'part.run/get', version: 1, input: request.input },
            caller,
          );
          if (live.ok) return live;
          const starts = await options.archive.read('run-start', caller);
          if (!starts.ok) return starts;
          const started = starts.value.find(
            (entry) =>
              isJsonObject(entry) && isJsonObject(entry.ref) && entry.ref.id === request.input,
          );
          return started === undefined
            ? fail('car.run', 'Run not found')
            : ok({
                phase: 'abandoned',
                effect: 'unknown',
                reconciliationRequired: true,
                start: started,
              });
        }
        default:
          return fail('car.query', 'Query is not installed', 'unsupported');
      }
    },
  };
  return {
    endpoint,
    hub: base.hub,
    /** @param {import('@slop-lab/part/reference/index.js').Client.Endpoint & {close(): Promise<Contracts.CleanupReport>}} next */
    attachWorkflows(next) {
      workflows = next;
    },
    async close() {
      return cleanupStages([
        { name: 'workflows', close: () => workflows?.close() },
        { name: 'agent-endpoint', close: () => base.close() },
      ]);
    },
  };
}
