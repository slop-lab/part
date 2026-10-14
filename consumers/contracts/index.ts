import { createAgent, contextPoint } from 'part/agent';
import { createContextCompiler, semanticItem } from 'part/context';
import { createControl, installAction } from 'part/control';
import { createChat } from 'part/ui-dom';
import { fakeModel } from 'part/testing';
import { ok, stringSchema } from 'part/contracts';
import type { Context, UI, Contracts } from 'part/reference';

const lowerer: Context.Lowerer<unknown> = {
  id: 'consumer/report-lowerer', accepts: { id: 'consumer/report', version: 1 },
  lower(item) { return ok({ kind: 'include', fragments: [{ id: item.id, kind: 'reference', role: 'user', content: [{ kind: 'text', text: 'Report' }], sources: [item.source], provenance: item.provenance }] }); },
};
const compiler = createContextCompiler({ lowerers: [lowerer] });
if (!compiler.ok) throw Error(compiler.error.message);
const agent = createAgent({ model: fakeModel([{ text: 'compiled' }]), customize: base => ({ ...base,
  edits: [registry => registry.replace({ point: contextPoint, replaces: 'part/base-context', with: { id: 'part/base-context', point: { ...contextPoint }, value: compiler.value } })],
}) });
if (!agent.ok) throw Error(agent.error.message);
const item = await semanticItem('consumer/report', { summary: 'safe' });
const result = await agent.value.generate([item]);
if (!result.ok || result.value.phase !== 'completed') throw Error('Consumer extension failed');
await agent.value.dispose();

const action = installAction({ id: 'consumer/read', version: 1, input: stringSchema, output: stringSchema,
  async describe() { return ok({ id: 'consumer/read', version: 1, input: stringSchema.ref, output: stringSchema.ref, execution: 'immediate', availability: { state: 'available', checkedAt: '1' } }); },
  async execute(request) { return { kind: 'completed', commandId: request.commandId, result: request.input, commit: [], effect: 'not-applied' }; },
});
if (!createControl({ actions: [action] }).ok) throw Error('Action extension failed');
const renderer: UI.Renderer<Contracts.Json, HTMLElement> = { id: 'consumer/card', type: 'consumer/card', schemaVersions: [1], target: 'chat',
  render(item) { const node = document.createElement('p'); node.textContent = item.fallback.label; return node; },
};
void renderer;
void createChat;
console.log('contract consumer passed');
