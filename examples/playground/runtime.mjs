import { createAgent } from '@part/plugins/agent';
import { createWatchHub } from '@part/core/client';
import { messageItem } from '@part/core/context';
import { canonical, fail, localContext, ok, schema, stringSchema } from '@part/core/contracts';
import { createMemoryArtifacts } from '@part/core/artifacts';
import { createSuspensions } from '@part/core/runtime/waits';
import { functionTool } from '@part/core/tools';
import catalog from './catalog.json' with { type: 'json' };
import { createPlaygroundModel, providerOptions } from './models.mjs';

const textInput = schema(
  'playground/text',
  (value) =>
    value &&
    typeof value === 'object' &&
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
const instructions = {
  tools: 'Call uppercase exactly once with the user text, then explain its result briefly.',
  approval:
    'Call save_note exactly once with the user text. Wait for the tool result before claiming the note was saved.',
  artifact: 'Call create_report exactly once with the user text, then briefly describe the report.',
  cancellation: 'Explain managed execution in detail using twelve short sections.',
  conversation: 'You are a concise assistant demonstrating part. Use Markdown when useful.',
};
const descriptor = (id) => ({
  id,
  version: 1,
  input: { id: 'part/null', version: 1 },
  output: { id: 'part/json', version: 1 },
  execution: 'immediate',
  availability: { state: 'available', checkedAt: '1' },
});

export function createPlaygroundSession({
  environment = {},
  delayScale = 1,
  context = localContext(),
} = {}) {
  const hub = createWatchHub({ revision: 'playground-1', entries: [] });
  const waits = createSuspensions();
  let artifacts = createMemoryArtifacts({ id: 'playground/reports', maxBytes: 128 * 1024 });
  const runs = [],
    history = new Map(),
    commands = new Map(),
    reports = new Map();
  let active,
    note = '',
    closed = false;
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
  const reject = (request, message) => ({
    kind: 'rejected',
    commandId: request.commandId,
    error: fail('playground.command', message, 'conflict').error,
  });
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
  async function start(request) {
    const input = request.input;
    if (
      !input ||
      typeof input !== 'object' ||
      typeof input.prompt !== 'string' ||
      !input.prompt.trim() ||
      input.prompt.length > 4000 ||
      !catalog.some((entry) => entry.id === input.scenario) ||
      !providerOptions(environment).some(
        (entry) => entry.id === input.provider && entry.available,
      ) ||
      (input.model !== undefined &&
        (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 120))
    )
      return reject(request, 'Choose a valid example/provider and enter 1–4,000 characters.');
    if (input.scenario === 'failure' && input.provider !== 'scripted')
      return reject(request, 'The deliberate invalid-argument example uses the scripted provider.');
    if (active) return reject(request, 'Stop or finish the current run first.');
    if (runs.length >= 24)
      return reject(request, 'This session has 24 runs. Clear the session to continue.');
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
          let result;
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
            if (!writer.ok) throw Error('Artifact writer unavailable');
            const written = await writer.value.write(new TextEncoder().encode(content));
            if (!written.ok) throw Error('Artifact write failed');
            const published = await writer.value.finalize();
            if (!published.ok) throw Error('Artifact finalization failed');
            const artifact = published.value;
            reports.set(artifact.ref.id, artifact);
            project(
              `${run.id}/report`,
              'playground/report',
              'Runtime field notes',
              'A finalized Markdown report. Open it in the inspector.',
              { ...artifact, name: 'runtime-report.md', mediaType: 'text/markdown' },
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
              const ticket = await waits.open(
                {
                  type: 'playground/note-approval',
                  responseSchema: decisionSchema,
                  presentation: { text: plan.validatedArguments.text },
                  bindingDigest: plan.digest,
                },
                caller,
              );
              if (!ticket.ok) return ticket;
              run.approval = ticket.value;
              run.phase = 'waiting';
              trace('approval-open', {
                ticket: ticket.value.id,
                text: plan.validatedArguments.text,
              });
              project(
                `${run.id}/approval`,
                'playground/approval',
                'Approve note write',
                plan.validatedArguments.text,
                { phase: 'waiting', text: plan.validatedArguments.text },
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
              if (!response.ok) return response;
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
        inspectRequest: (view) => trace('inspection', view),
      });
      if (!created.ok) throw Error('Agent composition failed');
      agent = created.value;
      run.agent = agent;
      const key = `${input.provider}/${input.model ?? ''}`;
      const previous = history.get(key) ?? [];
      const items = [
        await messageItem('system', [
          { kind: 'text', text: instructions[input.scenario] ?? instructions.tools },
        ]),
        ...previous,
        await messageItem('user', [{ kind: 'text', text: input.prompt }]),
      ];
      const started = await agent.start(items);
      if (!started.ok) throw Error('Run admission failed');
      run.handle = started.value;
      run.phase = 'running';
      project(`${run.id}/user`, 'part/message', 'You', input.prompt, { text: input.prompt });
      update();
      run.done = (async () => {
        const progress = (async () => {
          for await (const event of run.handle.observe()) {
            if (event.kind !== 'data') continue;
            if (event.type === 'part.model/text') {
              const text = event.payload.text;
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
        const outcome = await run.handle.done;
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
              items.at(-1),
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
        trace('run-ended', {
          phase: run.phase,
          effect: outcome.effect,
          error: run.error,
          usage: run.usage,
        });
        hub.remove(run.id);
        update();
      })().finally(async () => {
        if (run.approval) waits.cancel(run.approval.id);
        run.approval = null;
        await agent.dispose();
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
    async artifact(id) {
      const metadata = reports.get(id);
      if (!metadata) return null;
      const read = await artifacts.read(metadata.ref, undefined, context);
      if (!read.ok) return null;
      const chunks = [];
      for await (const chunk of read.value) chunks.push(chunk);
      return {
        bytes: Buffer.concat(chunks),
        mediaType: 'text/markdown',
        name: 'runtime-report.md',
      };
    },
    endpoint: {
      async command(request) {
        if (closed || request.actionVersion !== 1)
          return reject(request, 'The session is closed or the action version is unsupported.');
        const encoded = canonical(request),
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
        if (request.queryId === 'playground/state') return ok(state());
        if (request.queryId === 'part/capabilities')
          return ok({ revision: 'playground-1', entries: [] });
        return fail('playground.query', 'Unknown query');
      },
      async watch(_request, caller) {
        return hub.watch(caller);
      },
    },
    async close() {
      closed = true;
      await Promise.all([...commands.values()].map((entry) => entry.result));
      await active?.handle?.requestCancel('playground-shutdown');
      await active?.done;
      hub.close();
    },
  };
}
