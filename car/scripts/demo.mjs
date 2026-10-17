// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpPort } from '@slop-lab/part/client/http.js';
import { isJsonObject, localContext, ok } from '@slop-lab/part/contracts/index.js';
import {
  createMockProviderClient,
  startMockProvider,
} from '@slop-lab/part-node/testing/mock-provider/index.js';
import { createCarModel } from '../src/model.mjs';
import { openCar } from '../src/runtime.mjs';
import { startCarServer } from '../src/server.mjs';

/** Real HTTP model/tool/API path, with explicit operator decisions and no upstream key. */
export async function runCarDemo() {
  const directory = await mkdtemp(join(tmpdir(), 'car-demo-'));
  const root = join(directory, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root);
  await writeFile(join(root, 'answer.txt'), 'before\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: 'node check.cjs' } }),
  );
  await writeFile(
    join(root, 'check.cjs'),
    "const fs=require('node:fs');if(fs.readFileSync('answer.txt','utf8')!=='after\\n')process.exit(1);console.log('verified')",
  );
  const provider = await startMockProvider({
    mode: 'interactive',
    project: { id: 'car-demo', root },
  });
  const operator = createMockProviderClient(provider.session);
  const context = localContext({ principal: { subject: 'developer', authority: 'car/local' } });
  const model = createCarModel({
    baseURL: provider.session.baseURL,
    apiKey: provider.session.apiKey,
    model: 'car-test',
  });
  const stateDirectory = join(directory, 'state');
  let substitutes = 0;
  let car = await openCar({
    root,
    stateDirectory,
    model,
    context,
    trace: 'full',
    middleware: [
      {
        id: 'demo/substitute',
        version: '1',
        async decide(plan) {
          if (plan.definition.id !== 'swe_list') return ok({ kind: 'allow' });
          substitutes++;
          return ok({
            kind: 'substitute',
            reason: 'exercise interception',
            result: {
              value: { entries: [], substituted: true },
              content: [],
              artifacts: [],
              diagnostics: [],
            },
          });
        },
      },
    ],
  });
  const token = crypto.randomUUID();
  const server = await startCarServer(car, { context, token });
  const port = createHttpPort(server.url, {
    headers: () => ({ authorization: `Bearer ${token}` }),
  });
  let decisions = 0;
  /** @param {string} name @param {import('@slop-lab/part/reference/index.js').Contracts.Json} args */
  async function chooseTool(name, args) {
    const pending = await operator.pending(10_000, AbortSignal.timeout(15_000));
    const request = pending[0];
    assert.ok(request, 'A real model request must be pending');
    await operator.respond(request.id, `demo/${++decisions}`, {
      kind: 'completion',
      content: null,
      toolCalls: [{ id: `tool-${decisions}`, name, arguments: JSON.stringify(args) }],
    });
  }
  try {
    const observed = await port.watch({ surface: 'car' }, { signal: AbortSignal.timeout(30_000) });
    assert.ok(observed.ok);
    const watching = (async () => {
      for await (const frame of observed.value.frames) {
        if (
          frame.kind === 'event' &&
          frame.event.type === 'part.item/upsert' &&
          isJsonObject(frame.event.payload) &&
          isJsonObject(frame.event.payload.payload) &&
          frame.event.payload.payload.phase === 'completed'
        )
          return;
      }
      throw new Error('Run ended without a completed public projection');
    })();
    const started = await port.command({
      protocolVersion: 1,
      commandId: 'demo-run',
      idempotencyKey: 'demo-run',
      actionId: 'part.run/start',
      actionVersion: 1,
      input: 'Read answer.txt, change before to after, and verify it.',
    });
    assert.equal(started.kind, 'receipt');
    assert.equal(started.receipt.kind, 'accepted');
    await chooseTool('swe_read', { path: 'answer.txt' });
    const readRequest = (await operator.pending(10_000, AbortSignal.timeout(15_000)))[0];
    assert.ok(readRequest);
    const message = readRequest.request.messages
      .filter(isJsonObject)
      .find((item) => item.role === 'tool');
    assert.ok(message && typeof message.content === 'string');
    /** @type {unknown} */
    const read = JSON.parse(message.content);
    assert.ok(isJsonObject(read) && typeof read.digest === 'string' && Array.isArray(read.lines));
    const line = read.lines[0];
    assert.ok(isJsonObject(line) && typeof line.hash === 'string');
    await operator.respond(readRequest.id, `demo/${++decisions}`, {
      kind: 'completion',
      content: null,
      toolCalls: [
        {
          id: `tool-${decisions}`,
          name: 'swe_edit',
          arguments: JSON.stringify({
            path: 'answer.txt',
            expectedDigest: read.digest,
            edits: [{ line: 1, hash: line.hash, newText: 'after' }],
          }),
        },
      ],
    });
    await chooseTool('swe_list', { path: '.' });
    await chooseTool('swe_exec', { command: 'npm', args: ['test'] });
    const pending = (await operator.pending(10_000, AbortSignal.timeout(15_000)))[0];
    assert.ok(pending);
    const checkedMessage = pending.request.messages
      .filter(isJsonObject)
      .filter((item) => item.role === 'tool')
      .at(-1);
    assert.ok(checkedMessage && typeof checkedMessage.content === 'string');
    /** @type {unknown} */
    const processResult = JSON.parse(checkedMessage.content);
    assert.ok(isJsonObject(processResult));
    assert.equal(processResult.success, true);
    assert.equal(processResult.exitCode, 0);
    await operator.respond(pending.id, `demo/${++decisions}`, {
      kind: 'completion',
      content: 'Changed and verified answer.txt.',
    });
    await watching;
    await observed.value.close();
    assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), 'after\n');
    assert.equal(substitutes, 1);
    const requests = await port.query({ queryId: 'car.request/get', version: 1, input: null });
    assert.ok(requests.ok && isJsonObject(requests.value) && Array.isArray(requests.value.bodies));
    assert.equal(requests.value.bodies.length, 5);
    const transcript = await operator.transcript();
    assert.equal(
      transcript.requests.every((request) => request.state === 'responded'),
      true,
    );
    await operator.verify();
    // A second run is explicitly cancelled while waiting for its model response.
    const cancellation = await port.command({
      protocolVersion: 1,
      commandId: 'cancel-demo',
      actionId: 'part.run/start',
      actionVersion: 1,
      input: 'Wait for cancellation.',
    });
    assert.equal(cancellation.kind, 'receipt');
    assert.equal(cancellation.receipt.kind, 'accepted');
    await operator.pending(10_000, AbortSignal.timeout(15_000));
    const cancelled = await port.command({
      protocolVersion: 1,
      commandId: 'cancel-command',
      actionId: 'part.run/cancel',
      actionVersion: 1,
      target: cancellation.receipt.operation,
      input: null,
    });
    assert.equal(cancelled.kind, 'receipt');
    await server.close();
    await car.close();
    car = await openCar({ root, stateDirectory, model, context });
    const history = await car.endpoint.query(
      { queryId: 'car.history/path', version: 1, input: null },
      context,
    );
    assert.ok(history.ok);
    assert.match(JSON.stringify(history.value), /Changed and verified/);
    return {
      file: 'after',
      modelRequests: 5,
      substituteExecutions: substitutes,
      history: 'reopened',
      transport: 'real HTTP + SSE',
      cancellation: cancelled.kind === 'receipt' ? cancelled.receipt.kind : 'unknown',
    };
  } finally {
    await server.close();
    await car.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await runCarDemo()));
