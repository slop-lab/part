import { isJsonObject } from '@slop-lab/part/contracts/index.js';
import {
  ChatGPTSignInError,
  chatGPTResource,
  hasChatGPTPlanAccess,
  refreshChatGPTCredentials,
} from './oauth.js';
import type { ChatGPTCredentials } from './oauth.js';

export interface ChatGPTSessionOptions {
  credentials: ChatGPTCredentials;
  /** Persist the replacement atomically before issuing requests with it. */
  save: (credentials: ChatGPTCredentials) => void | Promise<void>;
  fetch?: typeof fetch;
}

/** A credential source for one account. Share one instance per account within the process. */
export function createChatGPTSession(options: ChatGPTSessionOptions) {
  const request = options.fetch ?? fetch;
  let credentials = options.credentials;
  let pendingSave = false;
  let refreshing: Promise<string> | undefined;

  async function persistRefresh() {
    await options.save(credentials);
    pendingSave = false;
  }

  async function currentAccessToken() {
    if (pendingSave) await persistRefresh();
    if (!hasChatGPTPlanAccess(credentials))
      throw new Error('ChatGPT plan usage has not been authorized');
    const now = Date.now();
    if (
      credentials.expiresAt <= now + 60_000 &&
      (credentials.refreshToken || credentials.expiresAt <= now)
    ) {
      credentials = await refreshChatGPTCredentials(credentials, request);
      pendingSave = true;
      await persistRefresh();
      if (!hasChatGPTPlanAccess(credentials))
        throw new Error('ChatGPT plan usage has not been authorized');
    }
    return credentials.accessToken;
  }

  function accessToken(): Promise<string> {
    refreshing ??= currentAccessToken().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  return {
    accessToken,
    async listModels(): Promise<readonly { id: string; name: string }[]> {
      const response = await request(`${chatGPTResource}/models`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : undefined;
        const identifier = (value: unknown) =>
          typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : undefined;
        const code = identifier(error?.code) ?? 'models_http_error';
        const requestId = identifier(
          response.headers.get('x-request-id') ?? response.headers.get('openai-request-id'),
        );
        throw new ChatGPTSignInError(
          'ChatGPT model list could not be loaded',
          code,
          response.status,
          requestId,
        );
      }
      const body: unknown = await response.json().catch(() => undefined);
      if (!isJsonObject(body) || !Array.isArray(body.models))
        throw new ChatGPTSignInError(
          'Invalid ChatGPT model list',
          'invalid_models_response',
          response.status,
        );
      return body.models
        .filter(isJsonObject)
        .flatMap((model) =>
          model.visibility === 'list' &&
          typeof model.slug === 'string' &&
          typeof model.display_name === 'string'
            ? [{ id: model.slug, name: model.display_name }]
            : [],
        );
    },
    /** Launch with the returned arguments and child-only environment. Renew before restarting Codex. */
    async codexAppServer() {
      const provider = 'openai_chatgpt_plan';
      const config = `model_providers.${provider}`;
      return {
        args: [
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          `model_provider="${provider}"`,
          '-c',
          `${config}.name="ChatGPT plan"`,
          '-c',
          `${config}.base_url="${chatGPTResource}"`,
          '-c',
          `${config}.env_key="ACCESS_TOKEN"`,
          '-c',
          `${config}.wire_api="responses"`,
          '-c',
          `${config}.requires_openai_auth=false`,
          '-c',
          `${config}.supports_websockets=false`,
        ],
        env: { ACCESS_TOKEN: await accessToken() },
      };
    },
  };
}
