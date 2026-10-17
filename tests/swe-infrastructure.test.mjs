// @ts-check
import { createDimTools } from '@slop-lab/part-node/swe/dim.js';
import { createToolsetRpc, ToolsetRpcError } from '@slop-lab/part-node/swe/toolset-rpc.js';
import { createToolsetTools } from '@slop-lab/part-node/swe/toolset.js';
import { localContext } from '@slop-lab/part/contracts/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, watch, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** @typedef {{ authorization?: string, method: string, params: { readonly [key: string]: import('@slop-lab/part/reference/index.js').Contracts.Json } }} RpcRequest */

const descriptor = {
  id: 'builtin.read',
  version: '7',
  description: 'Read a file',
  effects: ['read'],
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

test('toolset bindings discover an allowlist and preserve the complete native envelope', async () => {
  // Given
  /** @type {RpcRequest[]} */
  const requests = [];
  const fixture = await rpcFixture(requests, ({ method }) => {
    if (method === 'schema') return [descriptor, { ...descriptor, id: 'builtin.write' }];
    return completed('op-read', { content: 'hello' });
  });
  try {
    const registration = await createToolsetTools({
      endpoint: fixture.endpoint,
      token: 'secret',
      contextId: 'ctx-fixed',
      allowedTools: ['builtin.read'],
    });
    const dispatcher = dispatcherFor(registration.tools);
    const toolId = registration.toolIds['builtin.read'];
    assert.ok(toolId);

    // When
    const outcome = await dispatch(dispatcher, toolId, { path: 'a b' });

    // Then
    assert.equal(outcome.phase, 'completed');
    assert.deepEqual(outcome.result.value, completed('op-read', { content: 'hello' }));
    assert.deepEqual(Object.keys(registration.toolSchemas), [toolId]);
    assert.deepEqual(registration.toolSchemas[toolId], descriptor.inputSchema);
    const invokeRequest = requests[1];
    assert.ok(invokeRequest);
    assert.deepEqual(requests[0], { authorization: 'Bearer secret', method: 'schema', params: {} });
    assert.equal(invokeRequest.authorization, 'Bearer secret');
    assert.equal(invokeRequest.method, 'invoke');
    assert.deepEqual(invokeRequest.params.arguments, { path: 'a b' });
    assert.deepEqual(
      [
        invokeRequest.params.toolId,
        invokeRequest.params.contextId,
        invokeRequest.params.toolVersion,
        invokeRequest.params.async,
      ],
      ['builtin.read', 'ctx-fixed', '7', false],
    );
    assert.equal(typeof invokeRequest.params.idempotencyKey, 'string');
    if (typeof invokeRequest.params.idempotencyKey !== 'string')
      assert.fail('missing idempotency key');
    assert.match(invokeRequest.params.idempotencyKey, /^[0-9a-f-]{36}$/);
  } finally {
    await fixture.close();
  }
});

test('toolset native failure and lost external response never become successful writes', async () => {
  // Given
  let invocation = 0;
  const fixture = await rpcFixture([], ({ method }, response) => {
    if (method === 'schema') return [{ ...descriptor, id: 'builtin.write', effects: ['write'] }];
    invocation++;
    if (invocation === 2) {
      response.destroy();
      return undefined;
    }
    return {
      ...completed('op-write', null),
      execution: { state: 'failed' },
      error: { code: 'WRITE_FAILED' },
    };
  });
  try {
    const registration = await createToolsetTools({
      endpoint: fixture.endpoint,
      token: 'secret',
      contextId: 'ctx',
      allowedTools: ['builtin.write'],
    });
    const dispatcher = dispatcherFor(registration.tools);
    const toolId = registration.toolIds['builtin.write'];

    // When
    const nativeFailure = await dispatch(dispatcher, toolId, {});
    const lostResponse = await dispatch(dispatcher, toolId, {});

    // Then
    assert.equal(nativeFailure.phase, 'failed');
    assert.deepEqual(nativeFailure.error.details, {
      ...completed('op-write', null),
      execution: { state: 'failed' },
      error: { code: 'WRITE_FAILED' },
    });
    assert.equal(lostResponse.phase, 'failed');
    assert.equal(lostResponse.effect, 'unknown');
    assert.equal(invocation, 2);
  } finally {
    await fixture.close();
  }
});

test('toolset operation controls use exact get and cancel protocols', async () => {
  // Given
  /** @type {RpcRequest[]} */
  const requests = [];
  const fixture = await rpcFixture(requests, ({ method, params }) => {
    if (method === 'schema') return [];
    const operationId = params.operationId;
    if (typeof operationId !== 'string') assert.fail('missing operation id');
    return { id: operationId, phase: method === 'operation.cancel' ? 'cancelled' : 'running' };
  });
  try {
    const registration = await createToolsetTools({
      endpoint: fixture.endpoint,
      token: 'secret',
      contextId: 'ctx',
      allowedTools: [],
      operationControls: true,
    });
    const dispatcher = dispatcherFor(registration.tools);

    // When
    await dispatch(dispatcher, registration.operationToolIds.get, { operationId: 'op-1' });
    await dispatch(dispatcher, registration.operationToolIds.cancel, { operationId: 'op-1' });

    // Then
    assert.deepEqual(
      requests.slice(1).map(({ method, params }) => [method, params.operationId]),
      [
        ['operation.get', 'op-1'],
        ['operation.cancel', 'op-1'],
      ],
    );
  } finally {
    await fixture.close();
  }
});

test('toolset transport rejects pre-send cancellation, redirects, oversized responses and duplicate descriptors', async () => {
  // Given
  let sends = 0;
  const cancelledRpc = createToolsetRpc({
    endpoint: 'http://127.0.0.1/rpc',
    token: 'secret',
    fetch: async () => {
      sends++;
      return new Response('{}');
    },
  });
  const fixture = await rpcFixture([], ({ method }) =>
    method === 'schema' ? [descriptor, descriptor] : null,
  );
  try {
    // When / Then
    await assert.rejects(cancelledRpc('schema', {}, AbortSignal.abort()), (error) => {
      assert.ok(error instanceof ToolsetRpcError);
      return error.sent === false;
    });
    assert.equal(sends, 0);
    await assert.rejects(
      createToolsetTools({
        endpoint: fixture.endpoint,
        token: 'secret',
        contextId: 'ctx',
        allowedTools: ['builtin.read'],
      }),
      /duplicate/i,
    );
    await assert.rejects(
      createToolsetRpc({ endpoint: `${fixture.origin}/redirect`, token: 'secret' })(
        'schema',
        {},
        AbortSignal.timeout(1000),
      ),
    );
    await assert.rejects(
      createToolsetRpc({
        endpoint: `${fixture.origin}/large`,
        token: 'secret',
        maxResponseBytes: 32,
      })('schema', {}, AbortSignal.timeout(1000)),
      /limit/i,
    );
  } finally {
    await fixture.close();
  }
});

test('DIM bindings keep executable and workspace fixed and pass exec argv without a shell', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-dim-'));
  const executable = join(root, 'fake-dim.cjs');
  const log = join(root, 'argv.jsonl');
  await writeFile(
    executable,
    `const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[1]==='show'||a[1]==='start'||a[1]==='stop')console.log(JSON.stringify({name:a[2]}));else console.log('exec output');`,
  );
  try {
    const registration = createDimTools({
      executable: process.execPath,
      executableArgs: [executable],
      workspace: 'fixed workspace',
    });
    const dispatcher = dispatcherFor(registration.tools);

    // When
    await dispatch(dispatcher, registration.toolIds.show, {});
    const exec = await dispatch(dispatcher, registration.toolIds.exec, {
      argv: ['', 'a b', '$(touch nope)', 'quote"', 'trail\\'],
    });

    // Then
    assert.equal(exec.phase, 'completed');
    assert.deepEqual(
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        ['workspace', 'show', 'fixed workspace', '--json'],
        [
          'workspace',
          'exec',
          'fixed workspace',
          '--',
          '',
          'a b',
          '$(touch nope)',
          'quote"',
          'trail\\',
        ],
      ],
    );
    assert.equal(registration.toolIds.start, undefined);
    assert.equal(registration.toolIds.stop, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DIM lifecycle is explicit and process failure or cancellation is not reported as success', async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), 'part-dim-'));
  const executable = join(root, 'fake-dim.cjs');
  await writeFile(
    executable,
    `const fs=require('node:fs');const a=process.argv.slice(2);if(a[1]==='start')console.log('{}');else if(a.includes('fail'))process.exit(9);else {fs.writeFileSync(${JSON.stringify(join(root, 'ready'))},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}`,
  );
  try {
    const registration = createDimTools({
      executable: process.execPath,
      executableArgs: [executable],
      workspace: 'fixed',
      allowedActions: ['read', 'exec', 'start', 'stop'],
    });
    const dispatcher = dispatcherFor(registration.tools);
    const execToolId = registration.toolIds.exec;
    assert.ok(execToolId);

    // When
    const started = await dispatch(dispatcher, registration.toolIds.start, {});
    const failed = await dispatch(dispatcher, execToolId, { argv: ['fail'] });
    const ready = waitForFile(root, 'ready');
    const pending = await dispatcher.dispatch(
      { logicalCallId: crypto.randomUUID(), toolId: execToolId, arguments: { argv: ['wait'] } },
      localContext(),
    );
    assert.equal(pending.ok, true);
    await ready;
    await pending.value.requestCancel('test');
    const cancelled = await pending.value.done;

    // Then
    assert.equal(started.phase, 'completed');
    assert.equal(failed.phase, 'failed');
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal(cancelled.effect, 'unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** @param {string} operationId @param {import('@slop-lab/part/reference/index.js').Contracts.Json} data */
function completed(operationId, data) {
  return { operationId, execution: { state: 'completed' }, effects: [], data };
}

/** @param {import('@slop-lab/part/reference/index.js').Tools.Dispatcher} dispatcher @param {string | undefined} toolId @param {unknown} arguments_ */
async function dispatch(dispatcher, toolId, arguments_) {
  if (typeof toolId !== 'string') throw new TypeError('missing tool id');
  const started = await dispatcher.dispatch(
    { logicalCallId: crypto.randomUUID(), toolId, arguments: arguments_ },
    localContext(),
  );
  assert.equal(started.ok, true);
  return started.value.done;
}

/** @param {readonly import('@slop-lab/part/reference/index.js').Tools.InstalledTool[]} tools */
function dispatcherFor(tools) {
  const created = createToolDispatcher({ tools });
  assert.equal(created.ok, true);
  return created.value;
}

/** @param {RpcRequest[]} requests @param {(request: RpcRequest, response: import('node:http').ServerResponse) => import('@slop-lab/part/reference/index.js').Contracts.Json | undefined} handle */
async function rpcFixture(requests, handle) {
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(307, { location: '/rpc' });
      response.end();
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: 'x'.repeat(1024) }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ authorization: request.headers.authorization, ...rpc });
    const result = handle(rpc, response);
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    endpoint: `http://127.0.0.1:${address.port}/rpc`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      ),
  };
}

/** @param {string} directory @param {string} filename */
async function waitForFile(directory, filename) {
  for await (const event of watch(directory)) if (event.filename === filename) return;
}
