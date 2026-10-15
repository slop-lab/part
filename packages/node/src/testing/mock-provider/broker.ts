import { canonical } from '@part/core/contracts';
import { readFixture, readReply } from './protocol.js';
import type {
  MockChatRequest,
  MockFixture,
  MockProject,
  MockReply,
  MockRequestRecord,
  MockStatus,
  MockTranscript,
} from './types.js';

export function createMockBroker(options: {
  mode: 'interactive' | 'fixed';
  project: MockProject;
  fixture?: MockFixture;
  maxRequests: number;
  maxPending: number;
}) {
  const fixture = options.fixture ? readFixture(options.fixture) : undefined;
  if ((options.mode === 'fixed') !== !!fixture)
    throw Error('Fixed mode requires a fixture; interactive mode does not accept one');
  const records = new Map<string, MockRequestRecord>();
  const deliveries = new Map<string, (reply: MockReply) => void>();
  const listeners = new Set<() => void>();
  const failures: string[] = [];
  const recordFailure = (message: string) => {
    if (failures.length < options.maxRequests) failures.push(message);
  };
  let cursor = 0,
    closed = false;
  const project = structuredClone(options.project);
  const notify = () => {
    for (const wake of [...listeners]) wake();
  };
  const pending = () =>
    structuredClone([...records.values()].filter((record) => record.state === 'pending'));
  const status = (): MockStatus =>
    structuredClone({
      mode: options.mode,
      project,
      pending: pending().length,
      received: records.size,
      remaining: fixture ? fixture.exchanges.length - cursor : 0,
      failures: [...failures],
    });
  const inspect = (id: string) => {
    const record = records.get(id);
    if (!record) throw Error('Unknown request ID');
    return structuredClone(record);
  };
  function respond(id: string, decisionId: string, value: MockReply): MockRequestRecord {
    if (!decisionId) throw Error('decisionId is required');
    const reply = readReply(value),
      record = records.get(id);
    if (!record) throw Error('Unknown request ID');
    if (
      record.state === 'responded' &&
      record.decisionId === decisionId &&
      canonical(record.reply as unknown as import('@part/core/reference').Contracts.Json) ===
        canonical(reply as unknown as import('@part/core/reference').Contracts.Json)
    )
      return inspect(id);
    if (record.state !== 'pending') throw Error(`Request is already ${record.state}`);
    records.set(id, { ...record, state: 'responded', reply, decisionId });
    const deliver = deliveries.get(id);
    deliveries.delete(id);
    deliver?.(reply);
    notify();
    return inspect(id);
  }
  return {
    pending,
    status,
    inspect,
    respond,
    transcript(): MockTranscript {
      return structuredClone({
        schemaVersion: 1,
        mode: options.mode,
        project,
        requests: [...records.values()],
        failures: [...failures],
        remaining: status().remaining,
      });
    },
    verify() {
      if (
        closed &&
        failures.length === 0 &&
        !pending().length &&
        (!fixture || cursor === fixture.exchanges.length)
      )
        return;
      if (failures.length || pending().length || (fixture && cursor !== fixture.exchanges.length))
        throw Error(`Mock verification failed: ${JSON.stringify(status())}`);
    },
    admit(request: MockChatRequest, deliver: (reply: MockReply) => void): string {
      if (closed || records.size >= options.maxRequests || pending().length >= options.maxPending) {
        recordFailure('Mock provider is closed or at capacity');
        throw Error('Mock provider is closed or at capacity');
      }
      const id = `request-${records.size + 1}`;
      const record: MockRequestRecord = {
        id,
        project,
        request: structuredClone(request),
        state: 'pending',
      };
      records.set(id, record);
      deliveries.set(id, deliver);
      if (fixture) {
        const exchange = fixture.exchanges[cursor];
        if (!exchange || canonical(exchange.request) !== canonical(request)) {
          const message = exchange
            ? `Request does not match fixture exchange ${exchange.id}`
            : 'Unexpected extra request after fixture exhaustion';
          recordFailure(message);
          records.set(id, { ...record, state: 'mismatched' });
          deliveries.delete(id);
          deliver({ kind: 'error', status: 409, message, code: 'fixture_mismatch' });
        } else {
          cursor++;
          records.set(id, { ...record, fixtureId: exchange.id });
          respond(id, `fixture/${exchange.id}`, exchange.reply);
        }
      }
      notify();
      return id;
    },
    end(id: string, state: 'cancelled' | 'timed-out' | 'closed') {
      const record = records.get(id);
      if (!record || record.state !== 'pending') return;
      records.set(id, { ...record, state });
      recordFailure(`${id}: ${state}`);
      const deliver = deliveries.get(id);
      deliveries.delete(id);
      if (state !== 'cancelled')
        deliver?.({
          kind: 'error',
          status: state === 'timed-out' ? 504 : 503,
          message: `Mock request ${state}`,
          code: `mock_${state}`,
        });
      notify();
    },
    async wait(waitMs: number, signal?: AbortSignal): Promise<readonly MockRequestRecord[]> {
      if (!waitMs || pending().length || closed || signal?.aborted) return pending();
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          listeners.delete(finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        listeners.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
      return pending();
    },
    close() {
      closed = true;
      for (const [id, record] of records) if (record.state === 'pending') this.end(id, 'closed');
      notify();
    },
  };
}
