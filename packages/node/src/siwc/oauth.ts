import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isJsonObject } from '@slop-lab/part/contracts/index.js';
import { createIdentityVerifier, issuer } from './identity.js';
import type { ChatGPTIdentity } from './identity.js';

const dynamicClient = 'dynamic_agent_client';
const identityScopes = 'openid profile email';
const planScope = 'chatgpt.tokens.use.direct';
const invokeScope = 'resource.invoke';
const planScopes = `offline_access ${invokeScope} ${planScope}`;

export const chatGPTResource = 'https://api.openai.com/v1';

export interface ChatGPTRegistration {
  identity: ChatGPTIdentity;
  hostId: string;
  idToken?: string;
}

export interface ChatGPTCredentials extends ChatGPTRegistration {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: readonly string[];
}

export interface ChatGPTTransaction {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  redirectURI: string;
  clientId: string;
  hostId?: string;
  expectedSubject?: string;
}

export interface ChatGPTIdentityOptions {
  clientId: string;
  redirectURI: string | URL;
  clientSecret?: string;
  fetch?: typeof fetch;
}

export interface ChatGPTPlanOptions {
  appName: string;
  hostId: string;
  redirectURI: string | URL;
  fetch?: typeof fetch;
}

export class ChatGPTSignInError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ChatGPTSignInError';
  }
}

function callbackURI(value: URL | string, plan: boolean): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (plan ? !local : url.protocol !== 'https:' && !local)
  )
    throw new Error('Invalid SIWC redirect URI');
  return url.href;
}

function randomValue() {
  return randomBytes(32).toString('base64url');
}

function single(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new Error('Duplicate SIWC callback parameter');
  return values[0];
}

function sameState(state: string | undefined, expected: string): boolean {
  if (!state) return false;
  const left = Buffer.from(state);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function oauthCode(code: unknown): string {
  switch (code) {
    case 'access_denied':
    case 'invalid_grant':
    case 'invalid_refresh_token':
    case 'token_expired':
    case 'refresh_token_expired':
    case 'refresh_token_invalidated':
    case 'refresh_token_reused':
    case 'invalid_client':
    case 'invalid_request':
    case 'temporarily_unavailable':
      return code;
    default:
      return 'oauth_error';
  }
}

async function readOAuthJSON(response: Response) {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new ChatGPTSignInError(
      'OpenAI token request failed',
      oauthCode(isJsonObject(body) && body.error),
      response.status,
    );
  if (!isJsonObject(body)) throw new Error('Invalid OpenAI token response');
  return body;
}

function postForm(
  request: typeof fetch,
  path: string,
  body: URLSearchParams,
  authorization?: string,
) {
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  });
  if (authorization) headers.set('authorization', authorization);
  return request(`${issuer}/api/accounts/oauth/${path}`, {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
}

function createOAuthClient(options: ChatGPTIdentityOptions | ChatGPTPlanOptions) {
  const plan = 'hostId' in options;
  const redirectURI = callbackURI(options.redirectURI, plan);
  const request = options.fetch ?? fetch;
  const verify = createIdentityVerifier(request);
  if (
    plan
      ? !options.appName.trim() || !options.hostId.trim()
      : !options.clientId.trim() ||
        options.clientId === dynamicClient ||
        options.clientSecret === ''
  )
    throw new Error('Missing or invalid SIWC client configuration');

  function begin(registration?: ChatGPTRegistration, requestConsent = false) {
    if (
      registration &&
      (!plan ||
        registration.hostId !== options.hostId ||
        registration.identity.issuer !== issuer ||
        !registration.identity.subject ||
        !registration.identity.clientId ||
        registration.identity.clientId === dynamicClient)
    )
      throw new Error('Registration does not belong to this SIWC host');
    const clientId = plan ? (registration?.identity.clientId ?? dynamicClient) : options.clientId;
    const transaction: ChatGPTTransaction = {
      redirectURI,
      clientId,
      hostId: plan ? options.hostId : undefined,
      expectedSubject: registration?.identity.subject,
      state: randomValue(),
      nonce: randomValue(),
      verifier: randomValue(),
      expiresAt: Date.now() + 10 * 60_000,
    };
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectURI,
      response_type: 'code',
      scope: plan ? `${identityScopes} ${planScopes}` : identityScopes,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
    }).toString();
    if (plan) {
      url.searchParams.set('ext_agent_host_id', options.hostId);
      url.searchParams.set('resource', chatGPTResource);
      if (!registration) url.searchParams.set('agent_name_hint', options.appName);
      else if (requestConsent) url.searchParams.set('prompt', 'consent');
      if (registration?.idToken) url.searchParams.set('id_token_hint', registration.idToken);
      if (registration?.identity.email)
        url.searchParams.set('login_hint', registration.identity.email);
    }
    return { url, transaction };
  }

  async function complete(callback: URL | string, transaction: ChatGPTTransaction) {
    const url = new URL(callback);
    const params = new URLSearchParams(url.search);
    url.search = '';
    if (
      url.href !== redirectURI ||
      transaction.redirectURI !== redirectURI ||
      !Number.isFinite(transaction.expiresAt) ||
      transaction.expiresAt <= Date.now() ||
      (plan ? transaction.hostId !== options.hostId : transaction.clientId !== options.clientId) ||
      !sameState(single(params, 'state'), transaction.state)
    )
      throw new Error('SIWC callback does not match the sign-in transaction');
    const error = single(params, 'error');
    if (error !== undefined)
      throw new ChatGPTSignInError('OpenAI authorization failed', oauthCode(error));
    const code = single(params, 'code');
    const returnedClient = single(params, 'client_id');
    const clientId = transaction.clientId === dynamicClient ? returnedClient : transaction.clientId;
    if (
      !code ||
      !clientId ||
      clientId === dynamicClient ||
      (returnedClient !== undefined && returnedClient !== clientId)
    )
      throw new Error('SIWC callback is missing its code or has an unexpected client ID');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectURI,
      code_verifier: transaction.verifier,
    });
    if (plan) form.set('resource', chatGPTResource);
    const secret = 'clientSecret' in options ? options.clientSecret : undefined;
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    const authorization = secret
      ? `Basic ${Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString('base64')}`
      : undefined;
    const body = await readOAuthJSON(await postForm(request, 'token', form, authorization));
    if (typeof body.id_token !== 'string') throw new Error('OpenAI did not return an ID token');
    const identity = await verify(body.id_token, clientId, transaction.nonce);
    if (transaction.expectedSubject && transaction.expectedSubject !== identity.subject)
      throw new Error('OpenAI returned a different account for the saved registration');
    return { identity, body, idToken: body.id_token };
  }
  return { begin, complete };
}

/** Server-side website sign-in. Bind and consume transactions in your application session store. */
export function createChatGPTSignIn(options: ChatGPTIdentityOptions) {
  const oauth = createOAuthClient(options);
  return {
    begin: () => oauth.begin(),
    async complete(callback: URL | string, transaction: ChatGPTTransaction) {
      return (await oauth.complete(callback, transaction)).identity;
    },
  };
}

function readPlanTokens(
  body: Awaited<ReturnType<typeof readOAuthJSON>>,
  previousScopes?: readonly string[],
) {
  const { access_token, refresh_token, expires_in, token_type, scope } = body;
  if (
    typeof access_token !== 'string' ||
    !access_token ||
    (refresh_token !== undefined && (typeof refresh_token !== 'string' || !refresh_token)) ||
    typeof expires_in !== 'number' ||
    !Number.isSafeInteger(expires_in) ||
    expires_in <= 0 ||
    !Number.isSafeInteger(Date.now() + expires_in * 1000) ||
    typeof token_type !== 'string' ||
    token_type.toLowerCase() !== 'bearer' ||
    (scope !== undefined && typeof scope !== 'string')
  )
    throw new Error('Invalid ChatGPT plan token response');
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: Date.now() + expires_in * 1000,
    scopes: typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : (previousScopes ?? []),
  };
}

export function hasChatGPTPlanAccess(
  registration: ChatGPTRegistration,
): registration is ChatGPTCredentials {
  return (
    'accessToken' in registration &&
    typeof registration.accessToken === 'string' &&
    !!registration.accessToken &&
    'scopes' in registration &&
    Array.isArray(registration.scopes) &&
    registration.scopes.includes(planScope) &&
    registration.scopes.includes(invokeScope)
  );
}

/** Open-source plan registration and returning sign-in for one host. */
export function createChatGPTPlanSignIn(options: ChatGPTPlanOptions) {
  const oauth = createOAuthClient(options);
  return {
    begin(registration?: ChatGPTRegistration, options: { requestConsent?: boolean } = {}) {
      return oauth.begin(registration, options.requestConsent);
    },
    async complete(
      callback: URL | string,
      transaction: ChatGPTTransaction,
    ): Promise<ChatGPTRegistration | ChatGPTCredentials> {
      const { identity, body, idToken } = await oauth.complete(callback, transaction);
      const registration = { identity, hostId: options.hostId, idToken };
      const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/) : [];
      return scopes.includes(planScope) && scopes.includes(invokeScope)
        ? { ...registration, ...readPlanTokens(body) }
        : registration;
    },
  };
}

/** Exchange a rotating refresh token. Serialize refreshes and persist the returned record atomically. */
export async function refreshChatGPTCredentials(
  credentials: ChatGPTCredentials,
  request: typeof fetch = fetch,
): Promise<ChatGPTCredentials> {
  if (
    !credentials.refreshToken ||
    !credentials.identity.clientId ||
    credentials.identity.clientId === dynamicClient
  )
    throw new Error('ChatGPT sign-in is required again');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.identity.clientId,
    refresh_token: credentials.refreshToken,
    resource: chatGPTResource,
  });
  const tokens = readPlanTokens(
    await readOAuthJSON(await postForm(request, 'token', form)),
    credentials.scopes,
  );
  if (!tokens.refreshToken) throw new Error('OpenAI did not return a replacement refresh token');
  return { ...credentials, ...tokens };
}

/** Revoke the renewable session before clearing locally saved tokens. */
export async function revokeChatGPTCredentials(
  credentials: ChatGPTCredentials,
  request: typeof fetch = fetch,
) {
  if (!credentials.refreshToken) return;
  const response = await postForm(
    request,
    'revoke',
    new URLSearchParams({
      token: credentials.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: credentials.identity.clientId,
    }),
  );
  if (!response.ok)
    throw new ChatGPTSignInError(
      'OpenAI token revocation failed',
      'revocation_failed',
      response.status,
    );
}
