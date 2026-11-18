import { createPublicKey, verify } from 'node:crypto';
import { isJsonObject } from '@slop-lab/part/contracts/index.js';

export const issuer = 'https://auth.openai.com';

export interface ChatGPTIdentity {
  issuer: string;
  clientId: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  sessionId?: string;
}

function jwtPart(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Malformed ID token');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Malformed ID token');
  return decoded;
}

function jwtJSON(value: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jwtPart(value)));
  } catch {
    throw new Error('Malformed ID token');
  }
}

export function createIdentityVerifier(request: typeof fetch) {
  let cached: { keys: unknown[]; fetchedAt: number } | undefined;
  let loading: Promise<void> | undefined;

  async function fetchKeys() {
    const response = await request(`${issuer}/.well-known/jwks.json`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Could not load OpenAI signing keys');
    const body: unknown = await response.json();
    if (!isJsonObject(body) || !Array.isArray(body.keys))
      throw new Error('Invalid OpenAI signing keys');
    cached = { keys: body.keys, fetchedAt: Date.now() };
  }

  function loadKeys() {
    loading ??= fetchKeys().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  return async (idToken: string, clientId: string, nonce: string): Promise<ChatGPTIdentity> => {
    const [encodedHeader, encodedPayload, encodedSignature, ...extra] = idToken.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length)
      throw new Error('Malformed ID token');
    const header = jwtJSON(encodedHeader);
    if (
      !isJsonObject(header) ||
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.crit !== undefined ||
      header.b64 !== undefined
    )
      throw new Error('Unsupported OpenAI ID token signing header');

    if (!cached || Date.now() - cached.fetchedAt >= 600_000) await loadKeys();
    const matches = (key: unknown) =>
      isJsonObject(key) &&
      key.kid === header.kid &&
      key.kty === 'RSA' &&
      (key.use === undefined || key.use === 'sig') &&
      (key.alg === undefined || key.alg === 'RS256');
    let keys = cached?.keys.filter(matches) ?? [];
    if (!keys.length && cached && Date.now() - cached.fetchedAt >= 30_000) {
      await loadKeys();
      keys = cached?.keys.filter(matches) ?? [];
    }
    const key = keys.length === 1 ? keys[0] : undefined;
    if (!isJsonObject(key) || typeof key.n !== 'string' || typeof key.e !== 'string')
      throw new Error('OpenAI ID token signing key unavailable');
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        jwtPart(encodedSignature),
      )
    )
      throw new Error('Invalid OpenAI ID token signature');

    const claims = jwtJSON(encodedPayload);
    if (!isJsonObject(claims)) throw new Error('Invalid OpenAI ID token claims');
    const now = Date.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== issuer ||
      !audience.includes(clientId) ||
      audience.some((value) => typeof value !== 'string') ||
      ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
      claims.nonce !== nonce ||
      typeof claims.sub !== 'string' ||
      !claims.sub.trim() ||
      typeof claims.exp !== 'number' ||
      claims.exp <= now - 5 ||
      typeof claims.iat !== 'number' ||
      claims.iat > now + 5 ||
      claims.iat >= claims.exp ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + 5)) ||
      (claims.sid !== undefined && (typeof claims.sid !== 'string' || !claims.sid.trim()))
    )
      throw new Error('Invalid OpenAI ID token claims');
    return {
      issuer,
      clientId,
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      emailVerified:
        typeof claims.email === 'string' && !!claims.email && claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : undefined,
      picture: typeof claims.picture === 'string' ? claims.picture : undefined,
      sessionId: claims.sid,
    };
  };
}
