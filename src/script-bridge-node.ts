import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Contracts as C, Scripts as S } from './reference.js';
import type { ManagedBridge } from './script-bridge.js';
import { ok, fail, isJsonObject } from './contracts.js';
export interface ScriptBridgeEnvironment {
  environment(
    grantId: string,
    context: C.InvocationContext,
    audience?: string,
  ): C.Result<Readonly<Record<string, string>>>;
}
/** Explicit loopback listener; the public grant ID cannot authenticate a request. */
export async function startScriptBridge(
  bridge: ManagedBridge,
): Promise<C.Result<ScriptBridgeEnvironment & { close(): Promise<void> }>> {
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method !== 'POST' || request.url !== '/invoke') {
        send(404, fail('bridge.route', 'Unknown bridge route'));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 1024 * 1024) {
          send(413, fail('bridge.size', 'Bridge request too large'));
          return;
        }
        chunks.push(chunk);
      }
      const input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!isJsonObject(input) || typeof input.grantId !== 'string') {
        send(400, fail('bridge.request', 'Invalid bridge request'));
        return;
      }
      const credential = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const authenticated = bridge.authenticate(
        input.grantId,
        credential,
        String(request.headers['x-part-bridge-audience'] ?? ''),
      );
      if (!authenticated.ok) {
        send(403, authenticated);
        return;
      }
      send(200, await bridge.invoke(input as unknown as S.BridgeRequest, authenticated.value));
    } catch {
      send(400, fail('bridge.request', 'Invalid bridge request'));
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch {
    return fail('bridge.listen', 'Cannot start script bridge', 'unavailable');
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    return fail('bridge.address', 'Invalid bridge address');
  }
  const url = `http://127.0.0.1:${address.port}/invoke`;
  return ok({
    environment(id, context, audience) {
      const grant = bridge.grant(id, context);
      if (!grant.ok) return grant;
      if (audience !== undefined && audience !== grant.value.audience)
        return fail('bridge.audience', 'Script source is outside the grant audience', 'permission');
      const credential = bridge.credential(id, context);
      return credential.ok
        ? ok({
            PART_BRIDGE_URL: url,
            PART_BRIDGE_GRANT: id,
            PART_BRIDGE_AUDIENCE: grant.value.audience,
            PART_BRIDGE_CREDENTIAL: credential.value,
          })
        : credential;
    },
    async close() {
      bridge.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  });
}
/** Child helper: caller supplies a stable ID and reconciles the same request after uncertain delivery. */
export async function invokeScriptBridge(
  request: Omit<S.BridgeRequest, 'grantId'>,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<C.Result<C.CommandReceipt>> {
  try {
    const url = new URL(environment.PART_BRIDGE_URL ?? '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      return fail('bridge.endpoint', 'Expected a loopback bridge');
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${environment.PART_BRIDGE_CREDENTIAL ?? ''}`,
        'x-part-bridge-audience': environment.PART_BRIDGE_AUDIENCE ?? '',
      },
      body: JSON.stringify({ ...request, grantId: environment.PART_BRIDGE_GRANT }),
    });
    const receipt = await response.json();
    return response.ok
      ? ok(receipt as C.CommandReceipt)
      : fail('bridge.denied', 'Bridge call rejected', 'permission');
  } catch {
    return fail(
      'bridge.delivery',
      'Bridge delivery is unknown; reconcile using the same request ID',
      'unavailable',
      'unknown',
    );
  }
}
