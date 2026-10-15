import assert from 'node:assert/strict';
import { localContext, jsonSchema, ok } from '@slop-lab/part/contracts';
import { defineCodeWorkflow, createCodeEngine } from '@slop-lab/part-plugins/workflows/code';
import { createWorkflowHost } from '@slop-lab/part-plugins/workflows/host';
import { createWorkflowEndpoint } from '@slop-lab/part-plugins/workflows/endpoint';
import { createLocalPort, createController } from '@slop-lab/part/client';
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
const engine = createCodeEngine([definition], {}).value;
const endpoint = createWorkflowEndpoint({
  host: createWorkflowHost([engine]).value,
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
}).value;
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
  assert.equal(delivery.receipt.kind, 'accepted');
  assert.equal(
    (await controller.invoke(command)).receipt.operation.id,
    delivery.receipt.operation.id,
  );
  for (
    let i = 0;
    i < 100 && controller.getItem(delivery.receipt.operation.id)?.payload.phase !== 'succeeded';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 2));
  const item = controller.getItem(delivery.receipt.operation.id);
  assert.equal(item.payload.phase, 'succeeded');
  assert.deepEqual(item.payload.output.data, { received: { value: 42 } });
  assert.equal(item.payload.nativeState, undefined);
  assert.equal(executed, 1);
  console.log('Packed workflow consumer passed');
} finally {
  await controller.dispose();
  await endpoint.close();
}
