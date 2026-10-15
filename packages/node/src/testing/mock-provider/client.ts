import { isJsonObject } from '@part/core/contracts';
import type {
  MockProviderClient,
  MockReply,
  MockRequestRecord,
  MockSession,
  MockStatus,
  MockTranscript,
} from './types.js';
export function readMockSession(value: unknown): MockSession {
  if (
    !isJsonObject(value) ||
    value.schemaVersion !== 1 ||
    !['interactive', 'fixed'].includes(String(value.mode)) ||
    !isJsonObject(value.project) ||
    typeof value.project.id !== 'string' ||
    typeof value.apiKey !== 'string' ||
    !value.apiKey ||
    typeof value.controlToken !== 'string' ||
    !value.controlToken ||
    typeof value.baseURL !== 'string' ||
    typeof value.controlURL !== 'string'
  )
    throw Error('Invalid mock session descriptor');
  const provider = new URL(value.baseURL),
    control = new URL(value.controlURL);
  if (
    provider.protocol !== 'http:' ||
    provider.hostname !== '127.0.0.1' ||
    provider.pathname !== '/v1' ||
    provider.search ||
    provider.hash ||
    provider.username ||
    provider.password ||
    control.origin !== provider.origin ||
    control.pathname !== '/control' ||
    control.search ||
    control.hash ||
    control.username ||
    control.password
  )
    throw Error('Mock session must point to one loopback origin');
  return structuredClone(value) as unknown as MockSession;
}
export function createMockProviderClient(
  value: MockSession,
): MockProviderClient & { close(): Promise<void> } {
  const session = readMockSession(value);
  async function send<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${session.controlURL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${session.controlToken}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(35000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok) throw Error(`Mock control ${response.status}: ${JSON.stringify(result)}`);
    return result as T;
  }
  return {
    status: () => send<MockStatus>('/status'),
    pending: (waitMs = 0, signal) =>
      send<readonly MockRequestRecord[]>(`/requests?waitMs=${waitMs}`, undefined, signal),
    inspect: (id) => send<MockRequestRecord>(`/requests/${encodeURIComponent(id)}`),
    respond: (id, decisionId, reply: MockReply) =>
      send<MockRequestRecord>('/responses', { requestId: id, decisionId, reply }),
    transcript: () => send<MockTranscript>('/transcript'),
    async verify() {
      await send('/verify', {});
    },
    async close() {
      await send('/close', {});
    },
  };
}
