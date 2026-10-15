/** @public */
import type { ChatOptions } from './dom.js';
import { createChat } from './dom.js';
import type { ArtifactReader } from './inspector.js';
import { createInspector } from './inspector.js';
export function createWorkbench(options: ChatOptions & { artifacts?: ArtifactReader }): {
  element: HTMLElement;
  dispose(): Promise<void>;
} {
  const document = options.document ?? globalThis.document;
  const element = document.createElement('div');
  element.dataset.partPart = 'workbench';
  const chat = createChat({ ...options, ownsClient: false });
  const inspector = createInspector({
    client: options.client,
    document,
    artifacts: options.artifacts,
    renderers: options.renderers,
  });
  element.append(chat.element, inspector.element);
  return {
    element,
    async dispose() {
      await Promise.all([chat.dispose(), inspector.dispose()]);
      element.remove();
      if (options.ownsClient) await options.client.dispose();
    },
  };
}
