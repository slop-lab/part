import { freeze, jsonSchema } from '@slop-lab/part/contracts/index.js';
import type { Workflows } from '@slop-lab/part/reference/index.js';
import type { Execution } from './types.js';
export const memoryGuarantees: Workflows.Guarantees = freeze({
  control: 'runner-enforced',
  effects: 'runner-path-only',
  checkpoint: 'none',
  submissionDedupe: 'memory',
  scriptCancellation: 'cooperative',
  nativeSemantics: [
    'Trusted in-process definitions',
    'No stack recovery or automatic effect retry',
  ],
});
export function workflowSnapshot(execution: Execution, owner: string): Workflows.Snapshot {
  const state = execution.handle.snapshot(),
    phase = (
      {
        pending: 'queued',
        running: 'running',
        waiting: 'waiting',
        completed: 'succeeded',
        failed: 'failed',
        cancelled: 'cancelled',
        abandoned: 'unknown',
      } as const
    )[state.phase];
  const waiting = ['pending', 'running', 'waiting'].includes(state.phase)
    ? [...execution.waits.values()].filter((v) => v.ticket.state === 'open')
    : [];
  return {
    ref: execution.ref,
    revision: `${state.revision}/${execution.nativeRevision}`,
    definitionDigest: execution.prepared.definition.digest,
    owner: owner,
    phase: phase === 'running' && waiting.length ? 'waiting' : phase,
    nativeState: {
      schema: { id: `${owner}/state`, version: 1 },
      data: structuredClone(execution.native),
    },
    guarantees: memoryGuarantees,
    activeOperations: [...execution.active],
    waitingOn: waiting.map((w) => ({
      owner: 'part/waits',
      kind: w.ticket.type,
      id: w.ticket.id,
    })),
    ...(state.phase === 'completed' && execution.output ? { output: execution.output } : {}),
    diagnostics: state.error ? [state.error] : [],
    actions: waiting.length
      ? [
          {
            id: 'part.workflow/respond',
            version: 1,
            input: { id: 'part/workflow-response', version: 1 },
            output: jsonSchema.ref,
            execution: 'immediate',
            availability: { state: 'available', checkedAt: state.revision },
          },
        ]
      : [],
    effect: state.effect,
  };
}
