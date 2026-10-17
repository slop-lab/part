// @ts-check

const protectedHeaders = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
]);

/** @param {NodeJS.ProcessEnv} environment */
export function hasOpenAIProvider(environment) {
  return !!(environment.OPENAI_API_KEY && environment.OPENAI_BASE_URL && environment.OPENAI_MODEL);
}

/** @param {string | undefined} source */
function parseHeaders(source) {
  if (!source) return {};
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw Error('OPENAI_HEADERS must be a JSON object containing string values');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('OPENAI_HEADERS must be a JSON object containing string values');
  const headers = new Headers();
  for (const [name, value] of Object.entries(parsed)) {
    if (protectedHeaders.has(name.toLowerCase()))
      throw Error(`OPENAI_HEADERS cannot set protected header ${name}`);
    if (typeof value !== 'string') throw Error(`OPENAI_HEADERS value for ${name} must be a string`);
    try {
      headers.set(name, value);
    } catch {
      throw Error(`OPENAI_HEADERS contains an invalid header: ${name}`);
    }
  }
  return Object.fromEntries(headers.entries());
}

/** @param {NodeJS.ProcessEnv} environment */
export function readOpenAIProvider(environment) {
  const { OPENAI_API_KEY: key, OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: model } = environment;
  if (!key || !baseUrl || !model)
    throw Error('Configure OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL');
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw Error('OPENAI_BASE_URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(base.protocol))
    throw Error('OPENAI_BASE_URL must be a valid HTTP(S) URL');
  if (base.username || base.password) throw Error('OPENAI_BASE_URL must not contain credentials');
  if (base.search || base.hash) throw Error('OPENAI_BASE_URL must not contain a query or fragment');
  base.pathname = base.pathname
    .replace(/\/$/, '')
    .replace(/\/(?:responses|chat\/completions)$/, '');
  return { base, key, model, headers: parseHeaders(environment.OPENAI_HEADERS) };
}

/** @param {HeadersInit | undefined} initial @param {Readonly<Record<string, string>>} extra */
export function withOpenAIHeaders(initial, extra) {
  const headers = new Headers(initial);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return Object.fromEntries(headers.entries());
}

/** @param {URL} base @param {'responses' | 'chat/completions'} path */
export function openAIEndpoint(base, path) {
  const endpoint = new URL(base);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${path}`;
  return endpoint.href;
}
