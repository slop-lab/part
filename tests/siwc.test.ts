import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createChatGPTAccounts,
  createChatGPTPlanSignIn,
  createChatGPTSession,
  createChatGPTSignIn,
  createMemoryChatGPTAccountStore,
  createSqliteChatGPTAccountStore,
  hasChatGPTPlanAccess,
  signInWithChatGPTLoopback,
} from '@slop-lab/part-node/siwc/index.js';
import type { ChatGPTAccountStore, ChatGPTCredentials } from '@slop-lab/part-node/siwc/index.js';

const issuer = 'https://auth.openai.com';
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  alg: 'RS256',
  use: 'sig',
};

function token(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: issuer, sub: 'opaque-user', iat: now, exp: now + 600, ...claims }),
  ).toString('base64url');
  const data = Buffer.from(`${header}.${payload}`);
  return `${data}.${sign('RSA-SHA256', data, keys.privateKey).toString('base64url')}`;
}

function callback(authorization: URL, clientId?: string) {
  const url = new URL(authorization.searchParams.get('redirect_uri') ?? '');
  url.searchParams.set('state', authorization.searchParams.get('state') ?? '');
  url.searchParams.set('code', 'inert-code');
  if (clientId) url.searchParams.set('client_id', clientId);
  return url;
}

test('website SIWC verifies state before exchange and signed audience, subject and nonce after exchange', async () => {
  let requests = 0;
  let nonce = '';
  let audience = 'oaiapp_web';
  let tamper = false;
  const client = createChatGPTSignIn({
    clientId: 'oaiapp_web',
    clientSecret: 'special: secret',
    redirectURI: 'https://site.invalid/auth/callback',
    async fetch(url, init) {
      requests++;
      if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
      assert.equal(String(url), `${issuer}/api/accounts/oauth/token`);
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get('authorization'),
        `Basic ${Buffer.from('oaiapp_web:special%3A+secret').toString('base64')}`,
      );
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('redirect_uri'), 'https://site.invalid/auth/callback');
      assert.equal(init.body.has('client_secret'), false);
      const signed = token({
        aud: audience,
        nonce,
        email: 'user@example.test',
        email_verified: true,
      });
      return Response.json({
        id_token: tamper ? signed.replace(/\.[^.]+$/, '.AAAA') : signed,
      });
    },
  });
  const { url, transaction } = client.begin();
  assert.equal(url.searchParams.get('scope'), 'openid profile email');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(transaction.verifier).digest('base64url'),
  );
  const returned = callback(url);
  await assert.rejects(
    client.complete(returned, { ...transaction, state: 'wrong' }),
    /transaction/,
  );
  assert.equal(requests, 0);
  nonce = transaction.nonce;
  const identity = await client.complete(returned, transaction);
  assert.equal(identity.subject, 'opaque-user');
  assert.equal(identity.emailVerified, true);
  const second = client.begin();
  nonce = 'wrong';
  await assert.rejects(client.complete(callback(second.url), second.transaction), /claims/);
  nonce = second.transaction.nonce;
  audience = 'other-client';
  await assert.rejects(client.complete(callback(second.url), second.transaction), /claims/);
  const third = client.begin();
  nonce = third.transaction.nonce;
  audience = 'oaiapp_web';
  tamper = true;
  await assert.rejects(client.complete(callback(third.url), third.transaction), /signature/);
});

test('ChatGPT plan uses the issued client, checks returning identity, and rotates credentials once on concurrent use', async () => {
  let nonce = '';
  let subject = 'opaque-user';
  let granted = scope;
  let refreshes = 0;
  let saves = 0;
  const clientId = 'oaiapp_plan';
  const client = createChatGPTPlanSignIn({
    appName: 'Fixture',
    hostId: 'urn:uuid:fixture',
    redirectURI: 'http://127.0.0.1:1455/auth/callback',
    async fetch(url, init) {
      if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('client_id'), clientId);
      assert.equal(init.body.get('resource'), 'https://api.openai.com/v1');
      return Response.json({
        id_token: token({ aud: clientId, nonce, sub: subject }),
        scope: granted,
        access_token: 'initial',
        refresh_token: 'renew-me',
        expires_in: 1,
        token_type: 'Bearer',
      });
    },
  });
  const first = client.begin();
  nonce = first.transaction.nonce;
  assert.equal(first.url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.url.searchParams.get('agent_name_hint'), 'Fixture');
  await assert.rejects(client.complete(callback(first.url), first.transaction), /client ID/);
  const registration = await client.complete(callback(first.url, clientId), first.transaction);
  assert.ok(hasChatGPTPlanAccess(registration));

  const returning = client.begin(registration, { requestConsent: true });
  nonce = returning.transaction.nonce;
  assert.equal(returning.url.searchParams.get('client_id'), clientId);
  assert.equal(returning.url.searchParams.has('agent_name_hint'), false);
  assert.equal(returning.url.searchParams.get('prompt'), 'consent');
  await assert.rejects(
    client.complete(callback(returning.url, 'other-client'), returning.transaction),
    /client ID/,
  );
  subject = 'different-user';
  await assert.rejects(
    client.complete(callback(returning.url), returning.transaction),
    /different account/,
  );
  const denied = client.begin(registration);
  nonce = denied.transaction.nonce;
  subject = 'opaque-user';
  granted = 'openid profile email';
  const withoutPlan = await client.complete(callback(denied.url), denied.transaction);
  assert.equal(withoutPlan.identity.subject, subject);
  assert.equal(hasChatGPTPlanAccess(withoutPlan), false);
  assert.equal('accessToken' in withoutPlan, false);

  const session = createChatGPTSession({
    credentials: registration,
    async save(credentials) {
      assert.equal(credentials.refreshToken, 'next');
      saves++;
      if (saves === 1) throw new Error('temporary storage failure');
    },
    async fetch(url, init) {
      if (String(url).endsWith('/models')) {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fresh');
        return Response.json({
          models: [
            { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
            { slug: 'listed', display_name: 'Listed', visibility: 'list' },
          ],
        });
      }
      refreshes++;
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('grant_type'), 'refresh_token');
      assert.equal(init.body.get('refresh_token'), 'renew-me');
      assert.equal(init.body.has('scope'), false);
      return Response.json({
        access_token: 'fresh',
        refresh_token: 'next',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    },
  });
  const failed = await Promise.allSettled([session.accessToken(), session.accessToken()]);
  assert.ok(failed.every((result) => result.status === 'rejected'));
  const [models, codex] = await Promise.all([session.listModels(), session.codexAppServer()]);
  assert.deepEqual(models, [{ id: 'listed', name: 'Listed' }]);
  assert.equal(codex.env.ACCESS_TOKEN, 'fresh');
  assert.ok(codex.args.includes('model_providers.openai_chatgpt_plan.wire_api="responses"'));
  assert.ok(!codex.args.includes('fresh'));
  assert.equal(refreshes, 1);
  assert.equal(saves, 2);
});

test('SIWC loopback listener is ready before sign-in and ignores callbacks with the wrong state', async () => {
  let nonce = '';
  let browser: Promise<void> | undefined;
  const clientId = 'oaiapp_loopback';
  const registration = await signInWithChatGPTLoopback({
    appName: 'Fixture',
    hostId: 'urn:uuid:fixture',
    signal: AbortSignal.timeout(5000),
    open(url) {
      nonce = url.searchParams.get('nonce') ?? '';
      const valid = callback(url, clientId);
      browser = (async () => {
        const invalid = new URL(valid);
        invalid.searchParams.set('state', 'wrong');
        const rejected = await fetch(invalid);
        assert.equal(rejected.status, 400);
        await rejected.text();
        const accepted = await fetch(valid);
        assert.equal(accepted.status, 200);
        assert.match(await accepted.text(), /Sign-in complete/);
        await assert.rejects(fetch(valid));
      })();
      return browser;
    },
    async fetch(url) {
      if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
      return Response.json({ id_token: token({ aud: clientId, nonce }) });
    },
  });
  assert.equal(registration.identity.clientId, clientId);
  assert.ok(browser);
  await browser;
});

test('SIWC accepts a pasted callback once and validates the pending redirect and state', async () => {
  const clientId = 'oaiapp_paste';
  let nonce = '';
  let redirectURI = '';
  let exchanges = 0;
  const registration = await signInWithChatGPTLoopback({
    appName: 'Fixture',
    hostId: 'urn:uuid:fixture',
    signal: AbortSignal.timeout(5000),
    open(url, submitCallback) {
      nonce = url.searchParams.get('nonce') ?? '';
      redirectURI = url.searchParams.get('redirect_uri') ?? '';
      const valid = callback(url, clientId);
      const wrongHost = new URL(valid);
      wrongHost.hostname = 'localhost';
      const wrongState = new URL(valid);
      wrongState.searchParams.set('state', 'wrong');
      assert.equal(submitCallback(url.href), false);
      assert.equal(submitCallback(wrongHost.href), false);
      assert.equal(submitCallback(wrongState.href), false);
      assert.equal(submitCallback(redirectURI), false);
      assert.ok(submitCallback(`  ${valid.href}  `));
      assert.equal(submitCallback(valid.href), false);
    },
    async fetch(url, init) {
      if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
      exchanges++;
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('redirect_uri'), redirectURI);
      assert.equal(init.body.get('client_id'), clientId);
      assert.equal(init.body.get('code'), 'inert-code');
      return Response.json({ id_token: token({ aud: clientId, nonce }) });
    },
  });
  assert.equal(registration.identity.clientId, clientId);
  assert.equal(exchanges, 1);
});

test('owner-scoped accounts isolate model catalogs and recover rotated credentials after a storage error', async () => {
  const storage = createMemoryChatGPTAccountStore();
  let interrupted = false;
  let refreshes = 0;
  const store: ChatGPTAccountStore = {
    withAccount(owner, use) {
      return storage.withAccount(owner, (account, save) =>
        use(account, async (next) => {
          if (
            owner === 'alice' &&
            next &&
            'accessToken' in next &&
            next.accessToken === 'fresh-a' &&
            !interrupted
          ) {
            interrupted = true;
            throw new Error('temporary storage failure');
          }
          await save(next);
        }),
      );
    },
  };
  function registration(id: string, expired: boolean): ChatGPTCredentials {
    return {
      identity: { issuer, clientId: `oaiapp_${id}`, subject: id, emailVerified: false },
      hostId: 'urn:uuid:fixture',
      idToken: 'inert',
      accessToken: `token-${id}`,
      refreshToken: `refresh-${id}`,
      scopes: scope.split(' '),
      expiresAt: Date.now() + (expired ? -1 : 3_600_000),
    };
  }
  const accounts = createChatGPTAccounts({
    store,
    async fetch(url, init) {
      if (String(url).endsWith('/models')) {
        const bearer = new Headers(init?.headers).get('authorization');
        const id =
          bearer === 'Bearer fresh-a' ? 'alice' : bearer === 'Bearer token-b' ? 'bob' : 'wrong';
        return Response.json({ models: [{ slug: id, display_name: id, visibility: 'list' }] });
      }
      refreshes++;
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('refresh_token'), 'refresh-a');
      return Response.json({
        access_token: 'fresh-a',
        refresh_token: 'next-a',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    },
  });
  const alice = accounts.forUser('alice');
  const bob = accounts.forUser('bob');
  await Promise.all([
    alice.connect(registration('a', true)),
    bob.connect(registration('b', false)),
  ]);
  await assert.rejects(alice.accessToken(), /temporary storage failure/);
  const [first, other, second] = await Promise.all([
    alice.listModels(),
    bob.listModels(),
    accounts.forUser('alice').accessToken(),
  ]);
  assert.deepEqual(first, [{ id: 'alice', name: 'alice' }]);
  assert.deepEqual(other, [{ id: 'bob', name: 'bob' }]);
  assert.equal(second, 'fresh-a');
  assert.equal(refreshes, 1);
  await alice.disconnect();
  await assert.rejects(alice.accessToken(), /not been authorized/);
  assert.equal(await bob.accessToken(), 'token-b');
});

test('SQLite SIWC stores survive reopening and serialize rotating credentials per owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'part-siwc-accounts-'));
  let refreshes = 0;
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const request: typeof globalThis.fetch = async (_url, init) => {
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get('refresh_token'), 'old-refresh');
    refreshes++;
    entered.resolve(undefined);
    await finish.promise;
    return Response.json({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  };
  const service = () =>
    createChatGPTAccounts({
      store: createSqliteChatGPTAccountStore(directory),
      fetch: request,
    });
  const account = {
    identity: { issuer, subject: 'subject-a', clientId: 'oaiapp_a', emailVerified: false },
    hostId: 'urn:uuid:fixture',
    idToken: 'verified-id',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    scopes: scope.split(' '),
    expiresAt: 0,
  };
  try {
    await service().forUser('user-a').connect(account);
    const firstUser = service().forUser('user-a');
    const sameUser = service().forUser('user-a');
    const otherUser = service().forUser('user-b');
    assert.equal((await firstUser.registration())?.identity.subject, 'subject-a');
    const first = firstUser.accessToken();
    // Preserve the exception if opening the store fails before a refresh starts.
    await Promise.race([entered.promise, first]);
    const second = sameUser.accessToken();
    const secondResult = Promise.allSettled([second]);
    try {
      assert.equal(await otherUser.registration(), undefined);
      const otherAccount = {
        ...account,
        identity: { ...account.identity, subject: 'subject-b' },
        accessToken: 'user-b-access',
        expiresAt: Date.now() + 3600_000,
      };
      await otherUser.connect(otherAccount);
      assert.equal(await otherUser.accessToken(), 'user-b-access');
    } finally {
      finish.resolve(undefined);
    }
    assert.equal(await first, 'new-access');
    assert.deepEqual(await secondResult, [{ status: 'fulfilled', value: 'new-access' }]);
    assert.equal(refreshes, 1);
    assert.equal(await service().forUser('user-a').accessToken(), 'new-access');
    await firstUser.disconnect();
    assert.equal(await service().forUser('user-a').registration(), undefined);
    assert.equal(await service().forUser('user-b').accessToken(), 'user-b-access');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
