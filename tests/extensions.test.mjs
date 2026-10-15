import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail, localContext, stringSchema, jsonSchema, schema, digest } from 'part/contracts';
import { functionTool, createToolDispatcher } from 'part/agent/tools';
import { createContextCompiler, messageItem, semanticItem } from 'part/context';
import { createModelGateway, noAuth } from 'part/model';
import { createOllamaAdapter } from 'part/model/providers/ollama';
import { createSuspensions } from 'part/runtime/waits';
const context = localContext();
const decision = (id, decide, resume) => ({
  id,
  version: '1',
  decide: async (p) => ok(decide(p)),
  ...(resume ? { resume } : {}),
});
const call = (arguments_ = 'hello', toolId = 'echo') => ({
  logicalCallId: crypto.randomUUID(),
  toolId,
  arguments: arguments_,
});
const run = async (dispatcher, request) => {
  const h = await dispatcher.dispatch(request, context);
  return h.ok ? h.value.done : h;
};

test('MT05/MT06/MT07: deny, substitute, argument rewrite and redirect revalidation', async () => {
  let count = 0;
  const tools = [
    functionTool({
      id: 'echo',
      input: stringSchema,
      output: stringSchema,
      execute: (value) => {
        count++;
        return value;
      },
    }),
    functionTool({
      id: 'other',
      input: stringSchema,
      output: stringSchema,
      execute: (value) => {
        count++;
        return `other:${value}`;
      },
    }),
  ];
  const denied = createToolDispatcher({
    tools,
    middleware: [
      decision('deny', () => ({
        kind: 'deny',
        error: fail('fixture', 'Denied', 'permission').error,
      })),
    ],
  }).value;
  assert.equal((await run(denied, call())).phase, 'failed');
  assert.equal(count, 0);
  const substituted = createToolDispatcher({
    tools,
    middleware: [
      decision('substitute', () => ({
        kind: 'substitute',
        result: { value: 'fake', content: [], artifacts: [], diagnostics: [] },
        reason: 'fixture',
      })),
    ],
  }).value;
  assert.equal((await run(substituted, call())).result.value, 'fake');
  assert.equal(count, 0);
  const invalid = createToolDispatcher({
    tools,
    middleware: [
      decision('substitute', () => ({
        kind: 'substitute',
        result: { value: 1, content: [], artifacts: [], diagnostics: [] },
        reason: 'fixture',
      })),
    ],
  }).value;
  assert.equal((await run(invalid, call())).phase, 'failed');
  assert.equal(count, 0);
  const rewritten = createToolDispatcher({
    tools,
    middleware: [
      decision('rewrite', (p) =>
        p.validatedArguments === 'hello'
          ? { kind: 'replace-arguments', arguments: 'updated', reason: 'fixture' }
          : { kind: 'allow' },
      ),
      decision('policy', (p) =>
        p.validatedArguments === 'updated'
          ? { kind: 'deny', error: fail('policy', 'Updated arguments denied', 'permission').error }
          : { kind: 'allow' },
      ),
    ],
  }).value;
  assert.equal((await run(rewritten, call())).phase, 'failed');
  assert.equal(count, 0);
  const redirected = createToolDispatcher({
    tools,
    middleware: [
      decision('redirect', (p) =>
        p.definition.id === 'echo'
          ? { kind: 'redirect', toolId: 'other', arguments: 'moved', reason: 'fixture' }
          : { kind: 'allow' },
      ),
    ],
  }).value;
  assert.equal((await run(redirected, call())).result.value, 'other:moved');
  assert.equal(count, 1);
  const badRedirect = createToolDispatcher({
    tools,
    middleware: [
      decision('redirect', () => ({
        kind: 'redirect',
        toolId: 'other',
        arguments: 1,
        reason: 'fixture',
      })),
    ],
  }).value;
  assert.equal((await run(badRedirect, call())).phase, 'failed');
  assert.equal(count, 1);
});
test('suspend waits for validated response before executing exactly once', async () => {
  const waits = createSuspensions();
  let count = 0,
    captured;
  const dispatcher = createToolDispatcher({
    tools: [
      functionTool({
        id: 'echo',
        input: stringSchema,
        output: stringSchema,
        execute: (value) => {
          count++;
          return value;
        },
      }),
    ],
    waits,
    middleware: [
      decision(
        'approval',
        (p) => ({
          kind: 'suspend',
          ticket: {
            type: 'approval',
            responseSchema: jsonSchema,
            presentation: {},
            bindingDigest: p.digest,
          },
        }),
        async () => ok({ kind: 'allow' }),
      ),
    ],
  }).value;
  const originalOpen = waits.open;
  waits.open = async (...args) => {
    const result = await originalOpen(...args);
    captured = result.value;
    return result;
  };
  const handle = (await dispatcher.dispatch(call(), context)).value;
  while (!captured) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(count, 0);
  await waits.respond(captured, true, 'approve', context);
  assert.equal((await handle.done).phase, 'completed');
  assert.equal(count, 1);
});
test('MT10: invalid output after a write preserves the applied effect', async () => {
  let count = 0;
  const dispatcher = createToolDispatcher({
    tools: [
      functionTool({
        id: 'echo',
        input: stringSchema,
        output: stringSchema,
        effects: 'write',
        execute: () => {
          count++;
          return 42;
        },
      }),
    ],
  }).value;
  const outcome = await run(dispatcher, call());
  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.effect, 'applied');
  assert.equal(count, 1);
});
test('X01-X04: custom semantic lowering supports multiple fragments, versions and required failures', async () => {
  const item = await semanticItem('test/report', { text: 'raw', private: 'secret' });
  const original = structuredClone(item);
  const lowerer = {
    id: 'test/lower',
    accepts: { id: 'test/report', version: 1 },
    lower: (item) =>
      ok({
        kind: 'include',
        fragments: ['a', 'b'].map((id) => ({
          id,
          kind: 'reference',
          role: 'user',
          content: [{ kind: 'text', text: id }],
          sources: [item.source],
          provenance: item.provenance,
        })),
      }),
  };
  const compiler = createContextCompiler({ lowerers: [lowerer] }).value;
  const request = {
    sources: [item.source],
    input: [item],
    modelCapabilities: { revision: '1', entries: [] },
    toolsDigest: 'tools',
  };
  const compiled = await compiler.compile(request, context);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.value.fragments.length, 2);
  assert.equal(compiled.value.sourceVersions[0].observed, item.source.digest);
  assert.deepEqual(item, original);
  assert.equal((await createContextCompiler().value.compile(request, context)).ok, false);
  const tampered = { ...item, payload: { text: 'changed' } };
  assert.equal((await compiler.compile({ ...request, input: [tampered] }, context)).ok, false);
  const pruner = createContextCompiler({
    lowerers: [lowerer],
    transforms: [{ id: 'prune', transform: async () => ok([]) }],
  }).value;
  assert.equal((await pruner.compile(request, context)).ok, false);
});
test('MT02/MT03: decoder handles byte boundaries, native thinking, malformed arguments and unfinished EOF', () => {
  const adapter = createOllamaAdapter(),
    decoder = adapter.createDecoder({ status: 200, headers: {} }).value;
  const chunks = [
    { message: { role: 'assistant', content: '안녕', thinking: 'native' }, done: false },
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'echo', arguments: { text: 'ok' } } }],
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 1,
      eval_count: 2,
    },
  ];
  const bytes = new TextEncoder().encode(chunks.map((c) => JSON.stringify(c)).join('\n'));
  for (const byte of bytes) assert.equal(decoder.push(Uint8Array.of(byte)).ok, true);
  const result = decoder.finish();
  assert.equal(result.ok, true);
  assert.equal(result.value.content[0].text, '안녕');
  assert.equal(result.value.content[1].native.payload.thinking, 'native');
  assert.equal(result.value.toolCalls.length, 1);
  const eof = adapter.createDecoder({ headers: {} }).value;
  eof.push(new TextEncoder().encode(JSON.stringify(chunks[0]) + '\n'));
  assert.equal(eof.finish().ok, false);
  const malformed = adapter.createDecoder({ headers: {} }).value;
  assert.equal(
    malformed.push(
      new TextEncoder().encode(
        '{"message":{"tool_calls":[{"function":{"name":"x","arguments":"{"}}]},"done":true}\n',
      ),
    ).ok,
    false,
  );
  assert.equal(malformed.finish().ok, false);
});
test('MT04: inspection digest matches bytes after final request transform', async () => {
  const item = await messageItem('user', [{ kind: 'text', text: 'hello' }]);
  const compiled = (
    await createContextCompiler().value.compile(
      {
        input: [item],
        sources: [item.source],
        toolsDigest: 't',
        modelCapabilities: { revision: '1', entries: [] },
      },
      context,
    )
  ).value;
  const profile = {
    id: 'test',
    revision: '1',
    adapterId: 'part/ollama',
    transportId: 'test/transport',
    authStrategyId: 'none',
    model: 'fixture',
    defaults: {},
    capabilities: { revision: '1', entries: [] },
  };
  let actual, inspected;
  const gateway = createModelGateway({
    profiles: [profile],
    adapters: [createOllamaAdapter()],
    auth: { none: noAuth },
    transforms: [
      {
        id: 'final',
        apply: async (request) =>
          ok({ ...request, body: new TextEncoder().encode('{"transformed":true}') }),
      },
    ],
    inspect: (view) => {
      inspected = view;
    },
    transports: [
      {
        id: 'test/transport',
        send: async (request) => {
          actual = request.body;
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield new TextEncoder().encode('{"message":{"content":"ok"},"done":true}\n');
            })(),
          });
        },
      },
    ],
  }).value;
  const handle = (
    await gateway.invoke({ profileId: 'test', context: compiled, tools: [], options: {} }, context)
  ).value;
  assert.equal((await handle.done).phase, 'completed');
  assert.equal(inspected.actualDigest, await digest(actual));
  assert.equal(inspected.publicPayload, undefined);
});

test('X06: inspector targets confer no authority and unknown projections never expose raw payload', async () => {
  const { createProjectionService } = await import('part/context/projection');
  let reads = 0;
  const projection = createProjectionService({
    authorize: (_target, _audience, c) => c.principal.subject === 'local',
    load: async () => {
      reads++;
      return ok({ type: 'private/custom', schemaVersion: 1, value: { secret: 'must not escape' } });
    },
    projectors: new Map(),
  });
  const target = { owner: 'test', kind: 'record', id: 'private' },
    audience = { target: 'inspector', authorizationRevision: '1' };
  const denied = await projection.read(
    target,
    audience,
    localContext({ principal: { subject: 'stranger', authority: 'test' } }),
  );
  assert.equal(denied.ok, false);
  assert.equal(reads, 0);
  const fallback = await projection.read(target, audience, context);
  assert.equal(fallback.value[0].payload, null);
  assert.equal(JSON.stringify(fallback).includes('must not escape'), false);
});
