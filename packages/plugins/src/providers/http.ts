const protectedHeaders = new Set([
  'authorization',
  'content-type',
  'host',
  'content-length',
  'connection',
]);

export function providerHeaders(input: unknown, apiKeyHeader = false): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Custom headers must be an object of string values');
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (protectedHeaders.has(lower) || (apiKeyHeader && lower === 'x-api-key'))
      throw new TypeError(`Cannot set protected header ${name}`);
    if (typeof value !== 'string') throw new TypeError('Custom header values must be strings');
    try {
      headers.set(name, value);
    } catch {
      throw new TypeError(`Invalid custom header ${name}`);
    }
  }
  return Object.fromEntries(headers);
}

export function parseProviderHeaders(source?: string): Record<string, string> {
  if (!source) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError('Provider headers must be a JSON object of string values');
  }
  return providerHeaders(value);
}

export function providerEndpoint(
  baseURL: string | URL,
  path: 'chat/completions' | 'responses' | 'messages',
): URL {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new TypeError('Model base URL must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new TypeError('Model base URL must be HTTP(S)');
  if (url.username || url.password || url.search || url.hash)
    throw new TypeError('Model base URL must not contain credentials, a query or a fragment');
  const suffix = path === 'messages' ? /\/messages$/ : /\/(responses|chat\/completions)$/;
  const base = url.pathname.replace(/\/+$/, '').replace(suffix, '');
  url.pathname = `${base}/${path}`;
  return url;
}
