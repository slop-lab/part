// @ts-check
import { createDirectoryPackages } from '@slop-lab/part-node/packages.js';
import { createNodeScripts } from '@slop-lab/part-node/scripts/index.js';
import { createScriptHooks } from '@slop-lab/part-plugins/extensions/hooks.js';
import { createSkills, skillLowerer } from '@slop-lab/part-plugins/extensions/skills.js';
import { createCodeEngine, defineCodeWorkflow } from '@slop-lab/part-plugins/workflows/code.js';
import { createPipelineEngine } from '@slop-lab/part-plugins/workflows/pipeline/index.js';
import { digest, fail, jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createBoundary, managedAttempt } from '@slop-lab/part/runtime/index.js';
import { createSuspensions } from '@slop-lab/part/runtime/waits.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expectProperty, json, present, stub } from '../fixtures/assertions.mjs';
const context = localContext();
test('SR02/SR03/SR12: skill discovery and activation pin content and never execute bundled scripts', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'part-skill-')),
    root = join(temporary, 'report');
  await mkdir(root);
  await mkdir(join(root, 'scripts'));
  try {
    await writeFile(
      join(root, 'SKILL.md'),
      '---\nname: report\ndescription: Read a report\n---\nUse the supplied report.',
    );
    await writeFile(join(root, 'scripts', 'run.js'), 'throw Error("Must never execute");');
    const source = createDirectoryPackages(),
      packages = expectProperty(await source.discover([root], context), 'value'),
      skills = createSkills(source, packages);
    const descriptors = await skills.list(context);
    assert.equal(expectProperty(descriptors, 'value').length, 1);
    const owner = { owner: 'test', kind: 'run', id: context.scope.id };
    const activated = await skills.activate(
      {
        skillId: present(packages[0]).id,
        packageDigest: present(packages[0]).digest,
        owner,
        purpose: 'test',
        scope: 'run',
      },
      context,
    );
    assert.equal(activated.ok, true);
    assert.equal(activated.value.contextItems.length, 1);
    const lowered = skillLowerer().lower(stub(activated).value.contextItems[0]);
    assert.equal(
      present(expectProperty(expectProperty(lowered, 'value'), 'fragments')[0]).role,
      'user',
    );
    skills.closeOwner(owner);
    assert.equal((await skills.deactivate(activated.value.id, context)).ok, false);
    assert.equal((await source.read(present(packages[0]), '../outside', context)).ok, false);
    await writeFile(join(root, 'SKILL.md'), 'changed');
    assert.equal((await skills.list(context)).ok, false);
    await t.test('rejects symlinks', async (t) => {
      try {
        await symlink(temporary, join(root, 'escape'), 'junction');
      } catch (error) {
        if (
          expectProperty(error, 'code') === 'EPERM' ||
          expectProperty(error, 'code') === 'EACCES'
        ) {
          t.skip('Creating symlinks requires permission');
          return;
        }
        throw error;
      }
      assert.equal((await source.discover([root], context)).ok, false);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test('W15/SR12: awaited script hooks block malformed decisions, consume once and release scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'part-hook-'));
  try {
    const code = 'process.stdout.write(JSON.stringify({kind:"allow"}));';
    await writeFile(join(root, 'hook.cjs'), code);
    const scripts = createNodeScripts({ root, interpreters: { node: process.execPath } }),
      /** @type {import('@slop-lab/part/reference/index.js').Hooks.Point<unknown, unknown>} */
      point = {
        id: 'before',
        version: 1,
        owner: 'test',
        phase: 'before-effect',
        input: jsonSchema,
        output: jsonSchema,
        allowedDecisions: ['allow', 'deny'],
        awaited: true,
      };
    const hooks = expectProperty(createScriptHooks([point], scripts), 'value'),
      owner = { owner: 'test', kind: 'run', id: context.scope.id };
    /** @type {import('@slop-lab/part/reference/index.js').Hooks.Binding} */
    const binding = {
      id: 'hook',
      pointId: 'before',
      pointVersion: 1,
      activationOwner: owner,
      script: {
        requestId: 'hook-script',
        executorId: 'part/node-process',
        source: {
          relativePath: 'hook.cjs',
          digest: await digest(new TextEncoder().encode(code)),
        },
        interpreter: 'node',
        args: [],
        capture: { kind: 'stdout-json', maxBytes: 1024 },
        effects: 'read',
        retry: 'never',
      },
      failure: 'block',
      scope: 'run',
      once: true,
      reentrancy: 'deny',
    };
    assert.equal(
      (await hooks.bind({ ...binding, failure: 'report-and-continue' }, context)).ok,
      false,
    );
    assert.equal((await hooks.bind(binding, context)).ok, true);
    assert.equal(
      expectProperty(expectProperty(await hooks.fire('before', {}, context), 'value')[0], 'kind'),
      'allow',
    );
    assert.equal(expectProperty(await hooks.fire('before', {}, context), 'value').length, 0);
    hooks.closeOwner(owner);
    assert.equal(
      (await hooks.unbind({ owner: 'part/hooks', kind: 'binding', id: 'hook' }, context)).ok,
      false,
    );
    const invalid = 'process.stdout.write(JSON.stringify({kind:"not-allowed"}));';
    await writeFile(join(root, 'hook.cjs'), invalid);
    await hooks.bind(
      {
        ...binding,
        id: 'invalid',
        once: false,
        script: {
          ...binding.script,
          source: {
            ...binding.script.source,
            digest: await digest(new TextEncoder().encode(invalid)),
          },
        },
      },
      context,
    );
    let writes = 0;
    const boundary = createBoundary({
      prepare: async () => {
        const checked = await hooks.fire('before', {}, context);
        return checked.ok === true ? ok(undefined) : checked;
      },
    });
    const outcome = await managedAttempt(
      boundary,
      {
        operationId: 'o',
        attemptId: 'a',
        target: 'write',
        executor: 'test',
        inputDigest: 'i',
        scopeDigest: 's',
        compositionRevision: 'r',
        classification: 'write',
      },
      async () => {
        writes++;
        return { kind: 'returned', value: null, effect: 'applied' };
      },
      context,
    );
    assert.equal(outcome.phase, 'failed');
    assert.equal(writes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('W16: a hook cannot recursively invoke the same point through its script service', async () => {
  /** @type {Extract<ReturnType<typeof createScriptHooks>, {ok: true}>["value"]} */
  let hooks;
  /** @type {import("@slop-lab/part/reference/index.js").Scripts.Service} */
  const scripts = {
    execute: async (_request, c) => {
      const nested = await hooks.fire('before', {}, c);
      assert.equal(nested.ok, false);
      return fail('fixture.recursion', 'Nested hook denied');
    },
  };
  hooks = expectProperty(
    createScriptHooks(
      [
        {
          id: 'before',
          version: 1,
          owner: 'test',
          phase: 'before-effect',
          input: jsonSchema,
          output: jsonSchema,
          allowedDecisions: ['allow'],
          awaited: true,
        },
      ],
      scripts,
    ),
    'value',
  );
  await hooks.bind(
    {
      id: 'recursive',
      pointId: 'before',
      pointVersion: 1,
      activationOwner: { owner: 'test', kind: 'run', id: context.scope.id },
      script: {
        requestId: 'recursive',
        executorId: 'fake',
        source: { relativePath: 'none', digest: 'd' },
        interpreter: 'none',
        args: [],
        capture: { kind: 'stdout-json', maxBytes: 100 },
        effects: 'read',
        retry: 'never',
      },
      failure: 'block',
      scope: 'run',
      once: false,
      reentrancy: 'deny',
    },
    context,
  );
  assert.equal((await hooks.fire('before', {}, context)).ok, false);
});
test('W06/W07: cancelling a waiting pipeline rejects late responses and never starts a write', async () => {
  const waits = createSuspensions();
  /** @type {Parameters<typeof createPipelineEngine>[0]['definitions'][number]} */
  const definition = {
    format: 'part.pipeline',
    version: 1,
    id: 'wait-cancel',
    input: jsonSchema.ref,
    output: jsonSchema.ref,
    steps: [
      {
        id: 'review',
        after: [],
        kind: 'wait',
        response: jsonSchema.ref,
        binding: { input: '' },
        prompt: 'Approve?',
      },
      {
        id: 'approved',
        after: ['review'],
        kind: 'assert',
        value: { step: 'review', pointer: '' },
        equals: true,
      },
    ],
    result: { input: '' },
  };
  const engine = expectProperty(
    createPipelineEngine({
      definitions: [definition],
      schemas: [jsonSchema],
      services: { waits },
    }),
    'value',
  );
  const prepared = expectProperty(
    await engine.prepare(
      {
        engineId: engine.descriptor.id,
        definition: {
          id: expectProperty(definition, 'id'),
          format: 'part.pipeline',
          formatVersion: '1',
          digest: await digest(json(definition)),
          source: { owner: 'test', native: {} },
        },
        profileId: 'default',
        requiredCapabilities: [],
        requiredControl: 'runner-enforced',
      },
      context,
    ),
    'value',
  );
  const submission = await engine.start(
    { requestId: 'waiting', prepared, input: { data: 'fixed' } },
    context,
  );
  let state;
  for (let i = 0; i < 100; i++) {
    state = expectProperty(await engine.get(expectProperty(submission, 'ref'), context), 'value');
    if (state.phase === 'waiting') break;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(present(state).phase, 'waiting');
  await engine.requestCancel(expectProperty(submission, 'ref'), 'cancel', context);
  await new Promise((r) => setTimeout(r, 2));
  const late = await engine.action(
    expectProperty(submission, 'ref'),
    {
      protocolVersion: 1,
      commandId: 'late',
      actionId: 'part.workflow/respond',
      actionVersion: 1,
      input: { ticketId: present(present(state).waitingOn[0]).id, revision: '0', response: true },
    },
    context,
  );
  assert.equal(late.kind, 'rejected');
  assert.equal(
    expectProperty(await engine.get(expectProperty(submission, 'ref'), context), 'value').phase,
    'cancelled',
  );
});
test('workflow submission dedupe prevents concurrent starts from executing twice', async () => {
  let count = 0;
  const installed = await defineCodeWorkflow({
      id: 'dedupe',
      version: '1',
      input: jsonSchema,
      output: jsonSchema,
      replay: 'none',
      execute: async () => {
        count++;
        return ok(null);
      },
    }),
    engine = expectProperty(createCodeEngine([installed], {}), 'value');
  const prepared = expectProperty(
    await engine.prepare(
      {
        engineId: engine.descriptor.id,
        definition: {
          id: 'dedupe',
          format: 'part.code',
          formatVersion: '1',
          digest: installed.digest,
          source: { owner: 'test', native: {} },
        },
        profileId: 'default',
        requiredCapabilities: [],
        requiredControl: 'runner-enforced',
      },
      context,
    ),
    'value',
  );
  const request = { requestId: 'same', prepared, input: null };
  const [a, b] = await Promise.all([
    engine.start(request, context),
    engine.start(request, context),
  ]);
  assert.equal(expectProperty(a, 'ref').id, expectProperty(b, 'ref').id);
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(count, 1);
});
