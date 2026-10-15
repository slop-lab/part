import { createChat } from '@slop-lab/part-browser/dom.js';
import { createControl, installAction } from '@slop-lab/part/client/control.js';
import {
  createContextCompiler,
  lowerersPoint,
  semanticItem,
} from '@slop-lab/part/context/index.js';
import { localContext, ok, stringSchema } from '@slop-lab/part/contracts/index.js';
import type { Context, Contracts, UI } from '@slop-lab/part/reference/index.js';
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';

const lowerer: Context.Lowerer<unknown> = {
  id: 'consumer/report-lowerer',
  accepts: { id: 'consumer/report', version: 1 },
  lower(item) {
    return ok({
      kind: 'include',
      fragments: [
        {
          id: item.id,
          kind: 'reference',
          role: 'user',
          content: [{ kind: 'text', text: 'Report' }],
          sources: [item.source],
          provenance: item.provenance,
        },
      ],
    });
  },
};
const compiler = createContextCompiler({ lowerers: [lowerer] });
if (!compiler.ok) throw Error(compiler.error.message);
const extension = {
  descriptor: {
    id: 'consumer/report',
    version: '1',
    surfaces: ['local' as const],
    scope: 'runtime',
    requires: [{ id: 'part/context', contractVersion: 1, optional: false }],
    provides: [],
  },
  register(registry: import('@slop-lab/part/reference/index.js').Composition.RegistrationPort) {
    return registry.contribute({
      id: 'consumer/report-lowerer',
      point: { ...lowerersPoint },
      key: 'consumer/report@1',
      value: lowerer,
    });
  },
  create() {
    return ok({
      initialize: async () => ok(undefined),
      start: async () => ok(undefined),
      stop: async () => ({ released: [], unresolved: [], errors: [] }),
      dispose: async () => ({ released: [], unresolved: [], errors: [] }),
    });
  },
};
const agent = createAgent({ model: fakeModel([{ text: 'compiled' }]), components: [extension] });
if (!agent.ok) throw Error(agent.error.message);
const item = await semanticItem('consumer/report', { summary: 'safe' });
const result = await agent.value.generate([item]);
if (!result.ok || result.value.phase !== 'completed') throw Error('Consumer extension failed');
await agent.value.dispose();

const action = installAction({
  id: 'consumer/read',
  version: 1,
  input: stringSchema,
  output: stringSchema,
  async describe() {
    return ok({
      id: 'consumer/read',
      version: 1,
      input: stringSchema.ref,
      output: stringSchema.ref,
      execution: 'immediate',
      availability: { state: 'available', checkedAt: '1' },
    });
  },
  async execute(request) {
    return {
      kind: 'completed',
      commandId: request.commandId,
      result: request.input,
      commit: [],
      effect: 'not-applied',
    };
  },
});
const control = createControl({ actions: [action] });
if (!control.ok) throw Error('Action extension failed');
const receipt = await control.value.invoke(
  {
    protocolVersion: 1,
    commandId: 'consumer-action',
    actionId: 'consumer/read',
    actionVersion: 1,
    input: 'typed action',
  },
  localContext(),
);
if (receipt.kind !== 'completed' || receipt.result !== 'typed action')
  throw Error('Action invocation failed');
const renderer: UI.Renderer<Contracts.Json, HTMLElement> = {
  id: 'consumer/card',
  type: 'consumer/card',
  schemaVersions: [1],
  target: 'chat',
  render(item) {
    const node = document.createElement('p');
    node.textContent = item.fallback.label;
    return node;
  },
};
void renderer;
void createChat;
console.log('contract consumer passed');
