// @ts-check
import { messageItem, provenance } from '@slop-lab/part/context/index.js';
import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';

/** @import { Contracts, Context, Model, Runtime } from '@slop-lab/part/reference/index.js' */
/** @typedef {import('@slop-lab/part/reference/index.js').Convenience.Agent<string | readonly Context.SemanticItem[], Model.Response>} Agent */

/** Persist conversation through the history owner; one active branch writer.
 * @param {{agent: Agent, history: import('@slop-lab/part/context/history.js').HistoryService,
 * archive: ReturnType<import('./archive.mjs').createArchive>, context: Contracts.InvocationContext}} options
 * @returns {Promise<Agent>}
 */
export async function createConversation(options) {
  const { agent, history, archive, context } = options;
  const saved = await archive.get('session');
  if (!saved.ok) throw new Error(saved.error.message);
  let sessionId = saved.value?.value.value;
  if (typeof sessionId !== 'string') {
    const session = await history.createSession({ product: 'car' }, context);
    if (!session.ok) throw new Error(session.error.message);
    sessionId = session.value.id;
    const stored = await archive.set('session', sessionId);
    if (!stored.ok) throw new Error(stored.error.message);
  }
  const branchId = sessionId;
  let busy = false;
  let disposed = false;
  /** @type {Set<Promise<Runtime.ManagedOutcome<Model.Response>>>} */
  const finalizers = new Set();
  /** @param {'user'|'assistant'} role @param {string} text */
  const record = (role, text) => ({
    id: crypto.randomUUID(),
    type: 'car/message',
    schemaVersion: 1,
    payload: { role, text },
    provenance,
    createdAt: new Date().toISOString(),
    visibility: { model: true, conversation: true, inspector: true, export: true },
  });
  /** @type {Agent} */
  const conversation = {
    inspectComposition: () => agent.inspectComposition(),
    async dispose() {
      disposed = true;
      const cleanup = await agent.dispose();
      await Promise.all([...finalizers]);
      return cleanup;
    },
    async start(input) {
      if (disposed) return fail('car.closed', 'Conversation is closed', 'conflict');
      if (busy) return fail('car.busy', 'This conversation already has an active run', 'conflict');
      if (typeof input !== 'string') return fail('car.input', 'Conversation input must be text');
      busy = true;
      try {
        const current = await history.getBranch(branchId, context);
        if (!current.ok) {
          busy = false;
          return current;
        }
        const path = await history.path(current.value, undefined, context);
        if (!path.ok) {
          busy = false;
          return path;
        }
        /** @type {Context.SemanticItem[]} */
        const items = [];
        for (const entry of path.value.items) {
          const value = entry.record.payload;
          if (
            isJsonObject(value) &&
            (value.role === 'user' || value.role === 'assistant') &&
            typeof value.text === 'string'
          )
            items.push(await messageItem(value.role, [{ kind: 'text', text: value.text }]));
        }
        items.push(await messageItem('user', [{ kind: 'text', text: input }]));
        const appended = await history.append(current.value, [record('user', input)], context);
        if (!appended.ok) {
          busy = false;
          return appended;
        }
        const started = await agent.start(items);
        if (!started.ok) {
          busy = false;
          return started;
        }
        const handle = started.value;
        archive.record('run-start', { ref: { ...handle.ref }, input, sessionId: branchId });
        const progress = (async () => {
          for await (const update of handle.observe()) {
            if (update.kind === 'gap')
              archive.record('progress', { runId: handle.ref.id, gap: { ...update } });
            else if (update.type === 'part.tool/result' || update.type === 'part.operation/state')
              archive.record('progress', {
                runId: handle.ref.id,
                type: update.type,
                payload: update.payload,
              });
          }
        })();
        const done = handle.done
          .then(
            /** @returns {Promise<Runtime.ManagedOutcome<Model.Response>>} */ async (outcome) => {
              await progress;
              const text =
                outcome.phase === 'completed'
                  ? outcome.result.content
                      .filter((part) => part.kind === 'text')
                      .map((part) => part.text)
                      .join('')
                  : '';
              const recorded =
                outcome.phase === 'completed'
                  ? await history.append(appended.value, [record('assistant', text)], context)
                  : ok(undefined);
              archive.record('run-end', { ref: { ...handle.ref }, outcome });
              const flushed = await archive.flush();
              const error = !recorded.ok ? recorded.error : !flushed.ok ? flushed.error : undefined;
              return error ? { ...outcome, phase: 'failed', error } : outcome;
            },
          )
          .finally(() => {
            busy = false;
          });
        finalizers.add(done);
        void done.then(
          () => finalizers.delete(done),
          () => finalizers.delete(done),
        );
        return ok({ ...handle, done });
      } catch (error) {
        busy = false;
        throw error;
      }
    },
    async generate(input) {
      const run = await conversation.start(input);
      return run.ok ? ok(await run.value.done) : run;
    },
  };
  return conversation;
}
