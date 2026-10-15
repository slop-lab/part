// @ts-check
import { createCodeEngine, defineCodeWorkflow } from '@slop-lab/part-plugins/workflows/code.js';
import { createWorkflowEndpoint } from '@slop-lab/part-plugins/workflows/endpoint.js';
import { createWorkflowHost } from '@slop-lab/part-plugins/workflows/host.js';
import { createController, createLocalPort } from '@slop-lab/part/client/index.js';
import { jsonSchema, localContext, ok } from '@slop-lab/part/contracts/index.js';
import assert from 'node:assert/strict';
import { expectProperty, present } from '../../fixtures/assertions.mjs';
const context = localContext();
let executed = 0;
const definition = await defineCodeWorkflow({
  id: 'consumer/workflow',
  version: '1',
  input: jsonSchema,
  output: jsonSchema,
  replay: 'none',
  async execute(input) {
    executed++;
    return ok({ received: input });
  },
});
const engine = expectProperty(createCodeEngine([definition], {}), 'value');
const endpoint = expectProperty(
  createWorkflowEndpoint({
    host: expectProperty(createWorkflowHost([engine]), 'value'),
    context,
    composition: { id: 'consumer', revision: '1' },
    registrations: [
      {
        engineId: engine.descriptor.id,
        profileIds: ['default'],
        definition: {
          id: definition.definition.id,
          format: 'part.code',
          formatVersion: '1',
          digest: definition.digest,
          source: { owner: 'consumer', native: { installed: true } },
        },
      },
    ],
  }),
  'value',
);
const controller = createController(
  createLocalPort(endpoint, () => context, { codecLoopback: true }),
);
try {
  await controller.connect({ surface: 'workflow' });
  const command = {
    protocolVersion: 1,
    commandId: 'consumer/start',
    actionId: 'part.workflow/start',
    actionVersion: 1,
    input: {
      engineId: engine.descriptor.id,
      definition: { id: definition.definition.id, digest: definition.digest },
      profileId: 'default',
      composition: { id: 'consumer', revision: '1' },
      input: { value: 42 },
      requiredControl: 'runner-enforced',
      requiredCapabilities: [],
    },
  };
  const delivery = await controller.invoke(command);
  assert.equal(expectProperty(delivery, 'receipt').kind, 'accepted');
  assert.equal(
    present(
      expectProperty(expectProperty(await controller.invoke(command), 'receipt'), 'operation'),
    ).id,
    present(expectProperty(expectProperty(delivery, 'receipt'), 'operation')).id,
  );
  for (
    let i = 0;
    i < 100 &&
    expectProperty(
      controller.getItem(
        present(expectProperty(expectProperty(delivery, 'receipt'), 'operation')).id,
      )?.payload,
      'phase',
    ) !== 'succeeded';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 2));
  const item = controller.getItem(
    present(expectProperty(expectProperty(delivery, 'receipt'), 'operation')).id,
  );
  assert.ok(item);
  assert.equal(expectProperty(item.payload, 'phase'), 'succeeded');
  assert.deepEqual(expectProperty(expectProperty(item.payload, 'output'), 'data'), {
    received: { value: 42 },
  });
  assert.equal(Object.hasOwn(Object(item.payload), 'nativeState'), false);
  assert.equal(executed, 1);
  console.log('Packed workflow consumer passed');
} finally {
  await controller.dispose();
  await endpoint.close();
}
