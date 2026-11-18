// @ts-check
import {
  createProviderModel,
  parseProviderHeaders,
} from '@slop-lab/part-plugins/providers/index.js';

/** @param {string | undefined} source */
function parseHeaders(source, variable = 'OPENAI_HEADERS') {
  try {
    return parseProviderHeaders(source);
  } catch (error) {
    throw new TypeError(
      `${variable}: ${error instanceof Error ? error.message : 'Invalid headers'}`,
    );
  }
}

/** @param {Readonly<Record<string,string|undefined>>} environment
 * @param {{baseURL?: string, apiKey?: string, model?: string, headers?: string}} [overrides]
 * @param {'chat'|'responses'|'messages'} [protocol] */
export function readCarModelEnvironment(environment, overrides = {}, protocol = 'chat') {
  if (protocol === 'messages') {
    return {
      baseURL:
        overrides.baseURL ?? environment.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
      apiKey: overrides.apiKey ?? environment.ANTHROPIC_API_KEY ?? '',
      model: overrides.model ?? environment.ANTHROPIC_MODEL ?? '',
      headers: parseHeaders(
        overrides.headers ?? environment.ANTHROPIC_HEADERS,
        'ANTHROPIC_HEADERS',
      ),
    };
  }
  return {
    baseURL: overrides.baseURL ?? environment.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: overrides.apiKey ?? environment.OPENAI_API_KEY ?? '',
    model: overrides.model ?? environment.OPENAI_MODEL ?? '',
    headers: parseHeaders(overrides.headers ?? environment.OPENAI_HEADERS),
  };
}

/** Configure a compatible model HTTP API.
 * @param {{baseURL: string, apiKey: string, model: string, protocol?: 'chat'|'responses'|'messages',
 * headers?: Readonly<Record<string,string>>, timeoutMs?: number}} options
 * @returns {import('@slop-lab/part/reference/index.js').Convenience.ConfiguredModel}
 */
export function createCarModel(options) {
  const base = new URL(options.baseURL);
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    throw new TypeError('Model credentials require HTTPS or loopback HTTP');
  if (!options.apiKey || !options.model) throw new TypeError('Model name and API key are required');
  const protocol = options.protocol ?? 'chat';
  const suffix = protocol === 'messages' ? /\/messages$/ : /\/(?:responses|chat\/completions)$/;
  const prefix = base.pathname.replace(/\/+$/, '').replace(suffix, '');
  if (!prefix) base.pathname = '/v1';
  return createProviderModel({
    ...options,
    protocol,
    baseURL: base,
    id: `car/${protocol}`,
    defaults: { stream: true },
    timeoutMs: options.timeoutMs ?? 300_000,
  });
}
