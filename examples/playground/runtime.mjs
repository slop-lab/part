// @ts-check
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createMemoryArtifacts } from '@slop-lab/part/artifacts/index.js';
import { createWatchHub } from '@slop-lab/part/client/index.js';
import { messageItem } from '@slop-lab/part/context/index.js';
import {
  canonical,
  fail,
  isJson,
  localContext,
  ok,
  schema,
  stringSchema,
} from '@slop-lab/part/contracts/index.js';
import { createSuspensions } from '@slop-lab/part/runtime/waits.js';
import { functionTool } from '@slop-lab/part/tools.js';
import catalog from './catalog.json' with { type: 'json' };
import { createPlaygroundModel, providerOptions } from './models.mjs';

/** @import {Contracts, Client, Runtime, Model, Context, Projection} from '@slop-lab/part/reference/index.js' */
/**
 * @typedef {import('@slop-lab/part/reference/index.js').Convenience.Agent<string | readonly Context.SemanticItem[], Model.Response>} Agent
 * @typedef {{prompt: string, scenario: string, provider: string, model?: string}} StartInput
 * @typedef {{kind: string, at: string, data: Contracts.Json}} TraceEvent
 * @typedef {{id: string, scenario: string, provider: string, phase: string, text: string, events: TraceEvent[], approval: Runtime.WaitTicket | null, error: {code: string, message: string} | null, usage: Model.Response['usage'] | null, agent?: Agent, handle?: Runtime.ExecutionHandle<Model.Response>, done?: Promise<void>}} Run
 */
/** @param {unknown} value @returns {Contracts.Json} */
function wire(value) {
  if (!isJson(value)) throw Error('Invalid playground JSON data');
  return value;
}
const startInput = schema(
  'playground/start',
  /** @param {unknown} value @returns {value is StartInput} */
  (value) =>
    value !== null &&
    typeof value === 'object' &&
    'prompt' in value &&
    typeof value.prompt === 'string' &&
    !!value.prompt.trim() &&
    value.prompt.length <= 4000 &&
    'scenario' in value &&
    typeof value.scenario === 'string' &&
    catalog.some((entry) => entry.id === value.scenario) &&
    'provider' in value &&
    typeof value.provider === 'string' &&
    (!('model' in value) ||
      (typeof value.model === 'string' && !!value.model.trim() && value.model.length <= 120)),
);
const textInput = schema(
  'playground/text',
  /** @param {unknown} value @returns {value is {text: string}} */ (value) =>
    value !== null &&
    typeof value === 'object' &&
    'text' in value &&
    typeof value.text === 'string' &&
    value.text.length <= 4000,
);
const decisionSchema = schema('playground/decision', (value) => typeof value === 'boolean');
const parameters = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
/** @type {Record<string, string>} */
const instructions = {
  tools: 'Call uppercase exactly once with the user text, then explain its result briefly.',
  approval:
    'Call save_note exactly once with the user text. Wait for the tool result before claiming the note was saved.',
  artifact: 'Call create_report exactly once with the user text, then briefly describe the report.',
  cancellation: 'Explain managed execution in detail using twelve short sections.',
  conversation: 'You are a concise assistant demonstrating part. Use Markdown when useful.',
};
/** @param {string} id @returns {Contracts.ActionDescriptor} */
const descriptor = (id) => ({
  id,
  version: 1,
  input: { id: 'part/null', version: 1 },
  output: { id: 'part/json', version: 1 },
  execution: 'immediate',
  availability: { state: 'available', checkedAt: '1' },
});

export function createPlaygroundSession({
  environment = /** @type {NodeJS.ProcessEnv} */ ({}),
  delayScale = 1,
  context = localContext(),
} = {}) {
  const hub = createWatchHub({ revision: 'playground-1', entries: [] });
  const waits = createSuspensions();
  let artifacts = createMemoryArtifacts({ id: 'playground/reports', maxBytes: 128 * 1024 });
  /** @type {Run[]} */
  const runs = [];
  /** @type {Map<string, Context.SemanticItem[]>} */
  const history = new Map();
  /** @type {Map<string, {encoded: string, result: Promise<Contracts.CommandReceipt>}>} */
  const commands = new Map();
  /** @type {Map<string, import('@slop-lab/part/reference/index.js').Storage.FinalizedArtifact>} */
  const reports = new Map();
  /** @type {Run | undefined} */
  let active;
  let note = '',
    closed = false;
  /** @param {string} id @param {string} type @param {string} label @param {string} text @param {Contracts.Json} payload @param {Partial<Projection.Item>} extras */
  const project = (id, type, label, text, payload = {}, extras = {}) => {
    hub.upsert({
      id,
      type,
      schemaVersion: 1,
      revision: crypto.randomUUID(),
      payload,
      fallback: { label, text },
      actions: [],
      artifacts: [],
      ...extras,
    });
  };
  /** @param {Contracts.CommandRequest} request @param {string} message @returns {Contracts.CommandReceipt} */
  const reject = (request, message) => ({
    kind: 'rejected',
    commandId: request.commandId,
    error: fail('playground.command', message, 'conflict').error,
  });
  /** @param {Contracts.CommandRequest} request @param {Contracts.Json} result @returns {Contracts.CommandReceipt} */
  const complete = (request, result = null) => ({
    kind: 'completed',
    commandId: request.commandId,
    result,
    effect: 'not-applicable',
    commit: [],
  });
  function state() {
    return {
      note,
      runs: runs.map(({ id, scenario, provider, phase, text, events, approval, error, usage }) => ({
        id,
        scenario,
        provider,
        phase,
        text,
        events,
        approval,
        error,
        usage,
      })),
      active: active?.id ?? null,
    };
  }
  /** @param {Contracts.CommandRequest} request @returns {Promise<Contracts.CommandReceipt>} */
  async function start(request) {
    const validated = startInput.validate(request.input);
    if (!validated.ok)
      return reject(request, 'Choose a valid example/provider and enter 1?4,000 characters.');
    const input = validated.value;
    if (
      !providerOptions(environment).some((entry) => entry.id === input.provider && entry.available)
    )
      return reject(request, 'Choose an available provider.');
    if (input.scenario === 'failure' && input.provider !== 'scripted')
      return reject(request, 'The deliberate invalid-argument example uses the scripted provider.');
    if (active) return reject(request, 'Stop or finish the current run first.');
    if (runs.length >= 24)
      return reject(request, 'This session has 24 runs. Clear the session to continue.');
    /** @type {Run} */
    const run = {
      id: crypto.randomUUID(),
      ...input,
      phase: 'starting',
      text: '',
      events: [],
      approval: null,
      error: null,
      usage: null,
    };
    active = run;
    runs.push(run);
    const ref = { owner: 'playground', kind: 'run', id: run.id };
    const update = () =>
      project(
        run.id,
        'part/message',
        'Assistant',
        run.text,
        {
          ...(['completed', 'failed', 'cancelled', 'abandoned'].includes(run.phase)
            ? { phase: run.phase }
            : {}),
          status: run.phase,
          text: run.text,
          provider: run.provider,
          scenario: run.scenario,
        },
        {
          source: ref,
          actions: ['starting', 'running', 'waiting'].includes(run.phase)
            ? [descriptor('part.run/cancel')]
            : [],
        },
      );
    /** @param {string} kind @param {Contracts.Json} data */
    const trace = (kind, data) => {
      run.events.push({ kind, at: new Date().toISOString(), data });
      if (run.events.length > 64) run.events.shift();
    };
    const tools = ['uppercase', 'save_note', 'create_report'].map((id) =>
      functionTool({
        id,
        description: {
          uppercase: 'Convert text to uppercase',
          save_note: 'Save the session note after explicit user approval',
          create_report: 'Create an immutable Markdown report',
        }[id],
        input: textInput,
        output: stringSchema,
        effects: id === 'uppercase' ? 'read' : 'write',
        async execute({ text }, execution) {
          trace('tool-start', { tool: id, input: { text } });
          let result = '';
          if (id === 'uppercase') result = text.toUpperCase();
          if (id === 'save_note') {
            note = text;
            result = 'Session note saved';
          }
          if (id === 'create_report') {
            const content = `# Runtime field notes\n\n${text}\n\n## Findings\n\n- Keep ownership explicit.\n- Validate before executing tools.\n- Observe progress through public contracts.\n`;
            const writer = await artifacts.create(
              {
                mediaType: 'text/markdown',
                name: 'runtime-report.md',
                provenance: {
                  component: 'playground/report',
                  componentVersion: '1',
                  origin: 'agent',
                },
              },
              execution,
            );
            if (writer.ok === false) throw Error('Artifact writer unavailable');
            const written = await writer.value.write(new TextEncoder().encode(content));
            if (written.ok === false) throw Error('Artifact write failed');
            const published = await writer.value.finalize();
            if (published.ok === false) throw Error('Artifact finalization failed');
            const artifact = published.value;
            reports.set(artifact.ref.id, artifact);
            project(
              `${run.id}/report`,
              'playground/report',
              'Runtime field notes',
              'A finalized Markdown report. Open it in the inspector.',
              wire({ ...artifact, name: 'runtime-report.md', mediaType: 'text/markdown' }),
              { source: ref, artifacts: [artifact.ref] },
            );
            result = `Report artifact ${artifact.ref.id} finalized (${artifact.bytes} bytes)`;
          }
          trace('tool-result', { tool: id, output: result });
          project(`${run.id}/${id}`, 'part/tool', id, result, {
            toolId: id,
            outcome: 'completed',
            text: result,
          });
          return result;
        },
      }),
    );
    /** @type {Agent | undefined} */
    let agent;
    try {
      const model = createPlaygroundModel({
        ...input,
        model: input.model || environment.R4U_MODEL || 'gpt-6-luna',
        environment,
        delayScale,
        trace,
      });
      const created = createAgent({
        model,
        tools,
        principal: context.principal,
        toolSchemas: Object.fromEntries(tools.map((tool) => [tool.id, parameters])),
        limits: {
          maxModelInvocations: 4,
          maxToolDispatches: 4,
          deadline: new Date(Date.now() + 180000).toISOString(),
        },
        middleware: [
          {
            id: 'playground/approval',
            version: '1',
            async decide(plan, caller) {
              if (plan.call.toolId !== 'save_note') return ok({ kind: 'allow' });
              const argumentsResult = textInput.validate(plan.validatedArguments);
              if (argumentsResult.ok === false)
                return fail('playground.arguments', 'Invalid note arguments');
              const note = argumentsResult.value;
              const ticket = await waits.open(
                {
                  type: 'playground/note-approval',
                  responseSchema: decisionSchema,
                  presentation: { text: note.text },
                  bindingDigest: plan.digest,
                },
                caller,
              );
              if (ticket.ok === false) return ticket;
              run.approval = ticket.value;
              run.phase = 'waiting';
              trace('approval-open', {
                ticket: ticket.value.id,
                text: note.text,
              });
              project(
                `${run.id}/approval`,
                'playground/approval',
                'Approve note write',
                note.text,
                { phase: 'waiting', text: note.text },
                {
                  source: ref,
                  actions: [descriptor('playground/approve'), descriptor('playground/reject')],
                },
              );
              update();
              const response = await waits.wait(ticket.value, decisionSchema, caller);
              run.approval = null;
              if (response.ok) run.phase = 'running';
              project(
                `${run.id}/approval`,
                'playground/approval',
                'Note approval',
                response.ok ? (response.value ? 'Approved' : 'Rejected') : 'Cancelled',
                { phase: response.ok ? (response.value ? 'approved' : 'rejected') : 'cancelled' },
              );
              update();
              if (response.ok === false) return response;
              trace('approval-result', { approved: response.value });
              return ok(
                response.value
                  ? { kind: 'allow' }
                  : {
                      kind: 'deny',
                      error: fail('playground.denied', 'The note write was rejected.', 'permission')
                        .error,
                    },
              );
            },
          },
        ],
        inspectRequest: (view) => trace('inspection', wire(view)),
      });
      if (created.ok === false) throw Error('Agent composition failed');
      const createdAgent = created.value;
      agent = createdAgent;
      run.agent = agent;
      const key = `${input.provider}/${input.model ?? ''}`;
      const previous = history.get(key) ?? [];
      const items = [
        await messageItem('system', [
          { kind: 'text', text: instructions[input.scenario] ?? 'Use tools when needed.' },
        ]),
        ...previous,
        await messageItem('user', [{ kind: 'text', text: input.prompt }]),
      ];
      const started = await agent.start(items);
      if (started.ok === false) throw Error('Run admission failed');
      const handle = started.value;
      run.handle = handle;
      run.phase = 'running';
      project(`${run.id}/user`, 'part/message', 'You', input.prompt, { text: input.prompt });
      update();
      run.done = (async () => {
        const progress = (async () => {
          for await (const event of handle.observe()) {
            if (event.kind !== 'data') continue;
            if (event.type === 'part.model/text') {
              const payload = event.payload;
              if (
                !payload ||
                typeof payload !== 'object' ||
                !('text' in payload) ||
                typeof payload.text !== 'string'
              )
                throw Error('Invalid text event');
              const text = payload.text;
              hub.delta({
                itemId: run.id,
                partId: 'text',
                generation: run.id,
                offset: run.text.length,
                text,
              });
              run.text += text;
            } else if (event.type === 'part.tool/result') trace('dispatch', event.payload);
          }
        })();
        const outcome = await handle.done;
        await progress;
        run.phase = outcome.phase;
        if (outcome.phase === 'completed') {
          run.text = outcome.result.content
            .filter((part) => part.kind === 'text')
            .map((part) => part.text)
            .join('');
          run.usage = outcome.result.usage;
          history.set(
            key,
            [
              ...previous,
              await messageItem('user', [{ kind: 'text', text: input.prompt }]),
              await messageItem('assistant', [{ kind: 'text', text: run.text }]),
            ].slice(-12),
          );
        } else {
          run.error = outcome.error
            ? {
                code: outcome.error.code,
                message:
                  input.provider === 'scripted'
                    ? outcome.error.message
                    : 'Provider run did not complete. Inspect the structured code and local provider configuration.',
              }
            : null;
          run.text = `${run.text}${run.text ? '\n\n' : ''}${run.phase === 'cancelled' ? 'Run cancelled.' : (run.error?.message ?? 'Run ended without a result.')}`;
        }
        trace(
          'run-ended',
          wire({
            phase: run.phase,
            effect: outcome.effect,
            error: run.error,
            usage: run.usage,
          }),
        );
        hub.remove(run.id);
        update();
      })().finally(async () => {
        if (run.approval) waits.cancel(run.approval.id);
        run.approval = null;
        await createdAgent.dispose();
        if (active === run) active = undefined;
      });
      // Ensure an unexpected observer/disposal error cannot create an unhandled rejection.
      void run.done.catch(() => {
        run.phase = 'failed';
        run.text = 'Run observation failed.';
        update();
      });
      return { kind: 'accepted', commandId: request.commandId, operation: ref, commit: [] };
    } catch {
      await agent?.dispose();
      run.phase = 'failed';
      run.text = 'Could not start the run. Check the server provider configuration.';
      update();
      active = undefined;
      return reject(request, run.text);
    }
  }
  return {
    hub,
    context,
    state,
    /** @param {string} id */
    async artifact(id) {
      const metadata = reports.get(id);
      if (!metadata) return null;
      const read = await artifacts.read(metadata.ref, undefined, context);
      if (read.ok === false) return null;
      const chunks = [];
      for await (const chunk of read.value) chunks.push(chunk);
      return {
        bytes: Buffer.concat(chunks),
        mediaType: 'text/markdown',
        name: 'runtime-report.md',
      };
    },
    endpoint: /** @satisfies {Client.Endpoint} */ ({
      async command(request) {
        if (closed || request.actionVersion !== 1)
          return reject(request, 'The session is closed or the action version is unsupported.');
        const encoded = canonical(wire(request)),
          old = commands.get(request.commandId);
        if (old)
          return old.encoded === encoded
            ? old.result
            : reject(request, 'A command ID cannot be reused with different content.');
        if (commands.size >= 500)
          return reject(request, 'Command capacity reached. Start a new browser session.');
        const result = (async () => {
          if (request.actionId === 'part.run/start') return start(request);
          if (request.actionId === 'part.run/cancel') {
            if (!active?.handle || request.target?.id !== active.id)
              return reject(request, 'That run is no longer active.');
            await active.handle.requestCancel('playground-stop');
            return complete(request, { state: 'requested' });
          }
          if (['playground/approve', 'playground/reject'].includes(request.actionId)) {
            if (!active?.approval || request.target?.id !== active.id)
              return reject(request, 'That approval is no longer open.');
            const responded = await waits.respond(
              active.approval,
              request.actionId === 'playground/approve',
              request.commandId,
              context,
            );
            return responded.ok
              ? complete(request, { state: 'responded' })
              : reject(request, 'The approval has already closed.');
          }
          if (request.actionId === 'playground/clear') {
            if (active) return reject(request, 'Stop or finish the current run before clearing.');
            runs.length = 0;
            history.clear();
            reports.clear();
            artifacts = createMemoryArtifacts({ id: 'playground/reports', maxBytes: 128 * 1024 });
            note = '';
            hub.reset([], crypto.randomUUID());
            return complete(request);
          }
          return reject(request, 'Unsupported action');
        })();
        commands.set(request.commandId, { encoded, result });
        return result;
      },
      async query(request) {
        if (request.version !== 1) return fail('playground.query', 'Unsupported query version');
        if (request.queryId === 'playground/state') return ok(wire(state()));
        if (request.queryId === 'part/capabilities')
          return ok({ revision: 'playground-1', entries: [] });
        return fail('playground.query', 'Unknown query');
      },
      async watch(_request, caller) {
        return hub.watch(caller);
      },
    }),
    async close() {
      closed = true;
      await Promise.all([...commands.values()].map((entry) => entry.result));
      await active?.handle?.requestCancel('playground-shutdown');
      await active?.done;
      hub.close();
    },
  };
}
