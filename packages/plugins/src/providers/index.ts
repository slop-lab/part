import { bearerAuth, createFetchTransport, noAuth } from '@slop-lab/part/model/index.js';
import type { Contracts, Convenience } from '@slop-lab/part/reference/index.js';
import { createAnthropicMessagesAdapter } from './anthropic/index.js';
import { providerEndpoint, providerHeaders } from './http.js';
import { createOpenAICompatibleAdapter } from './openai-compatible/index.js';
import { createOpenAIResponsesAdapter } from './openai-responses/index.js';

export { parseProviderHeaders } from './http.js';

export type ModelCredential = string | (() => string | Promise<string>);

export interface ModelOptions {
  model: string;
  modelMap?: Readonly<Record<string, string>>;
  id?: string;
  defaults?: Readonly<Record<string, Contracts.Json>>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ProviderModelOptions extends ModelOptions {
  protocol: 'chat' | 'responses' | 'messages';
  baseURL?: string | URL;
  apiKey?: ModelCredential;
  auth?: 'bearer' | 'x-api-key';
  headers?: Readonly<Record<string, string>>;
  anthropicVersion?: string;
}

function configure(
  options: ProviderModelOptions,
  chatGPTPlan = false,
): Convenience.ConfiguredModel {
  const { protocol } = options;
  const messages = protocol === 'messages';
  const adapter = messages
    ? createAnthropicMessagesAdapter()
    : protocol === 'responses'
      ? createOpenAIResponsesAdapter({ chatGPTPlan })
      : createOpenAICompatibleAdapter();
  const endpoint = providerEndpoint(
    options.baseURL ?? (messages ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
    protocol === 'chat' ? 'chat/completions' : protocol,
  );
  const apiKeyHeader = (options.auth ?? (messages ? 'x-api-key' : 'bearer')) === 'x-api-key';
  const extra = providerHeaders(options.headers ?? {}, apiKeyHeader);
  const model =
    options.modelMap && Object.hasOwn(options.modelMap, options.model)
      ? options.modelMap[options.model]
      : options.model;
  if (!model?.trim() || !options.model.trim()) throw new TypeError('Model name is required');
  const { apiKey, timeoutMs } = options;
  if (apiKey === '') throw new TypeError('API key must not be empty');
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)
  )
    throw new TypeError('Invalid model timeout');
  const auth =
    apiKey === undefined
      ? noAuth
      : bearerAuth(() => (typeof apiKey === 'function' ? apiKey() : apiKey));
  return {
    profile: {
      id: options.id ?? `${adapter.id}/${encodeURIComponent(options.model)}`,
      revision: '1',
      adapterId: adapter.id,
      transportId: 'part/fetch',
      authStrategyId: apiKey === undefined ? 'none' : 'bearer',
      model,
      endpoint: endpoint.href,
      defaults: options.defaults ?? {},
      capabilities: { revision: '1', entries: [] },
    },
    adapter,
    auth,
    transport: createFetchTransport({
      allowedOrigins: [endpoint.origin],
      fetch(url, init) {
        const headers = new Headers(extra);
        for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
        if (messages) {
          headers.set(
            'anthropic-version',
            options.anthropicVersion ?? headers.get('anthropic-version') ?? '2023-06-01',
          );
        }
        const bearer = headers.get('authorization');
        if (apiKeyHeader && bearer) {
          headers.set('x-api-key', bearer.slice('Bearer '.length));
          headers.delete('authorization');
        }
        const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
        const signal =
          timeout && init?.signal
            ? AbortSignal.any([init.signal, timeout])
            : (timeout ?? init?.signal);
        return (options.fetch ?? fetch)(url, { ...init, headers, signal });
      },
    }),
  };
}

/** Configure a model for Chat Completions, Responses or Anthropic Messages. */
export function createProviderModel(options: ProviderModelOptions): Convenience.ConfiguredModel {
  if (!['chat', 'responses', 'messages'].includes(options.protocol))
    throw new TypeError('Unsupported model protocol');
  if (options.auth !== undefined && !['bearer', 'x-api-key'].includes(options.auth))
    throw new TypeError('Unsupported model authentication');
  return configure(options);
}

/** Use an authorized SIWC access token with the public, streaming Responses API. */
export function createChatGPTModel(
  options: ModelOptions & { accessToken: ModelCredential },
): Convenience.ConfiguredModel {
  return configure(
    {
      ...options,
      protocol: 'responses',
      baseURL: 'https://api.openai.com/v1',
      apiKey: options.accessToken,
      auth: 'bearer',
      headers: {},
    },
    true,
  );
}
