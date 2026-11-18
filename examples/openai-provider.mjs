// @ts-check
import {
  createProviderModel,
  parseProviderHeaders,
} from '@slop-lab/part-plugins/providers/index.js';

/** @param {NodeJS.ProcessEnv} environment */
export function hasOpenAIProvider(environment) {
  return !!(environment.OPENAI_API_KEY && environment.OPENAI_MODEL);
}

/** @param {NodeJS.ProcessEnv} environment
 * @param {{protocol: 'chat' | 'responses', id?: string, model?: string, stream?: boolean,
 * maxTokens?: number, fetch?: typeof fetch}} options */
export function createExampleOpenAIModel(environment, options) {
  const { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: baseURL, OPENAI_MODEL: model } = environment;
  if (!apiKey || !model) throw Error('Configure OPENAI_API_KEY and OPENAI_MODEL');
  const { protocol, stream = true, maxTokens = 512 } = options;
  let headers;
  try {
    headers = parseProviderHeaders(environment.OPENAI_HEADERS);
  } catch (error) {
    throw new TypeError(
      `OPENAI_HEADERS: ${error instanceof Error ? error.message : 'Invalid headers'}`,
    );
  }
  return createProviderModel({
    protocol,
    apiKey,
    baseURL,
    model: options.model ?? model,
    id: options.id ?? protocol,
    headers,
    defaults: {
      stream,
      ...(protocol === 'responses'
        ? { max_output_tokens: maxTokens }
        : { max_completion_tokens: maxTokens }),
    },
    timeoutMs: 90_000,
    fetch: options.fetch,
  });
}
