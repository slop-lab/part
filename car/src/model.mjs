// @ts-check
import { bearerAuth, createFetchTransport } from '@slop-lab/part/model/index.js';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses/index.js';

/** Router4u and other explicitly configured compatible endpoints, not an embedded router.
 * @param {{baseURL: string, apiKey: string, model: string, protocol?: 'chat'|'responses',
 * route?: string, timeoutMs?: number}} options
 * @returns {import('@slop-lab/part/reference/index.js').Convenience.ConfiguredModel}
 */
export function createCarModel(options) {
  const base = new URL(options.baseURL);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new TypeError('Model base URL must be an HTTP origin/path without credentials or query');
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw new TypeError('Model credentials require HTTPS or loopback HTTP');
  if (!options.apiKey || !options.model) throw new TypeError('Model name and API key are required');
  base.pathname = base.pathname
    .replace(/\/$/, '')
    .replace(/\/(?:responses|chat\/completions)$/, '');
  if (!base.pathname || base.pathname === '/') base.pathname = '/v1';
  const protocol = options.protocol ?? 'chat';
  const adapter =
    protocol === 'responses' ? createOpenAIResponsesAdapter() : createOpenAICompatibleAdapter();
  const endpoint = `${base.toString().replace(/\/$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`;
  return {
    profile: {
      id: `car/${protocol}`,
      revision: '1',
      adapterId: adapter.id,
      transportId: 'part/fetch',
      authStrategyId: 'bearer',
      model: options.model,
      endpoint,
      defaults: { stream: true },
      capabilities: { revision: '1', entries: [] },
    },
    adapter,
    auth: bearerAuth(async () => options.apiKey),
    transport: createFetchTransport({
      allowedOrigins: [base.origin],
      fetch(url, init = {}) {
        return fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            ...(options.route ? { 'X-Router4u-Route': options.route } : {}),
          },
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(options.timeoutMs ?? 300_000),
          ]),
        });
      },
    }),
  };
}
