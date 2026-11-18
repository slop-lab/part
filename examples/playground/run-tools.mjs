// @ts-check
import { fail, ok, schema, stringSchema } from '@slop-lab/part/contracts/index.js';
import { functionTool } from '@slop-lab/part/tools.js';

/** @import {Contracts, Projection, Storage} from '@slop-lab/part/reference/index.js' */
/** @typedef {Parameters<typeof import('@slop-lab/part-plugins/agent/index.js').createAgent>[0]} AgentOptions */
/**
 * @typedef {{
 *   run: Pick<import('./runtime.mjs').Run, 'id' | 'phase' | 'approval'>,
 *   ref: NonNullable<Projection.Item['source']>,
 *   waits: ReturnType<typeof import('@slop-lab/part/runtime/waits.js').createSuspensions>,
 *   getArtifacts: () => ReturnType<typeof import('@slop-lab/part/artifacts/index.js').createMemoryArtifacts>,
 *   reports: Map<string, Storage.FinalizedArtifact>,
 *   saveNote: (text: string) => void,
 *   trace: (kind: string, data: Contracts.Json) => void,
 *   project: (id: string, type: string, label: string, text: string, payload: Contracts.Json, extras?: Partial<Projection.Item>) => void,
 *   update: () => void,
 *   descriptor: (id: string) => Contracts.ActionDescriptor,
 *   wire: (value: unknown) => Contracts.Json
 * }} RunToolOptions
 */

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
/** @param {RunToolOptions} options */
export function createRunTools({
  run,
  ref,
  waits,
  getArtifacts,
  reports,
  saveNote,
  trace,
  project,
  update,
  descriptor,
  wire,
}) {
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
          saveNote(text);
          result = 'Session note saved';
        }
        if (id === 'create_report') {
          const content = `# Runtime field notes\n\n${text}\n\n## Findings\n\n- Keep ownership explicit.\n- Validate before executing tools.\n- Observe progress through public contracts.\n`;
          const writer = await getArtifacts().create(
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
  const middleware = /** @satisfies {NonNullable<AgentOptions['middleware']>} */ ([
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
  ]);

  return {
    tools,
    toolSchemas: Object.fromEntries(tools.map((tool) => [tool.id, parameters])),
    middleware,
  };
}
