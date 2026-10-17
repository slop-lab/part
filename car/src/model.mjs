// @ts-check
import { bearerAuth, createFetchTransport } from '@slop-lab/part/model/index.js';
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses/index.js';

const protectedHeaders = new Set([
  'authorization',
  'content-type',
  'host',
  'content-length',
  'connection',
]);

/** @param {Readonly<Record<string, string>>} input */
function checkedHeaders(input) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (protectedHeaders.has(name.toLowerCase()))
      throw new TypeError(`Cannot set protected header ${name}`);
    if (typeof value !== 'string') throw new TypeError('Custom header values must be strings');
    try {
      headers.set(name, value);
    } catch (error) {
      if (error instanceof TypeError) throw new TypeError(`Invalid custom header ${name}`);
      throw error;
    }
  }
  return Object.fromEntries(headers.entries());
}

/** @param {string | undefined} source */
function parseHeaders(source) {
  if (!source) return {};
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError('OPENAI_HEADERS must be a JSON object of string values');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError('OPENAI_HEADERS must be a JSON object of string values');
  /** @type {Record<string,string>} */
  const headers = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new TypeError('OPENAI_HEADERS values must be strings');
    Object.defineProperty(headers, name, { value, enumerable: true });
  }
  return checkedHeaders(headers);
}

/** @param {Readonly<Record<string,string|undefined>>} environment
 * @param {{baseURL?: string, apiKey?: string, model?: string, headers?: string}} [overrides] */
export function readCarModelEnvironment(environment, overrides = {}) {
  return {
    baseURL: overrides.baseURL ?? environment.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: overrides.apiKey ?? environment.OPENAI_API_KEY ?? '',
    model: overrides.model ?? environment.OPENAI_MODEL ?? '',
    headers: parseHeaders(overrides.headers ?? environment.OPENAI_HEADERS),
  };
}

/** Configure a generic OpenAI-compatible HTTP API.
 * @param {{baseURL: string, apiKey: string, model: string, protocol?: 'chat'|'responses',
 * headers?: Readonly<Record<string,string>>, timeoutMs?: number}} options
 * @returns {import('@slop-lab/part/reference/index.js').Convenience.ConfiguredModel}
 */
export function createCarModel(options) {
  const extraHeaders = checkedHeaders(options.headers ?? {});
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
        const headers = new Headers(init.headers);
        for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
        return fetch(url, {
          ...init,
          headers,
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(options.timeoutMs ?? 300_000),
          ]),
        });
      },
    }),
  };
}
