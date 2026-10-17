import { fail, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import { installTool } from '@slop-lab/part/tools.js';
import { WorkspaceFileError } from './files.js';

type WorkspaceToolDefinition = {
  readonly id: string;
  readonly description: string;
  readonly effects: 'read' | 'write';
  readonly input: Contracts.Schema<Record<string, unknown>>;
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export function installWorkspaceTool(options: WorkspaceToolDefinition): Tools.InstalledTool {
  return installTool({
    definition: {
      id: options.id,
      version: '1',
      description: options.description,
      input: options.input,
      executor: 'part/function',
      effects: options.effects,
      cancellation: 'cooperative',
      retrySafety: options.effects === 'read' ? 'read-only' : 'never',
      requiredCapabilities: [],
    },
    async execute(input) {
      try {
        const value = await options.execute(input);
        return ok({ value, content: [], artifacts: [], diagnostics: [] });
      } catch (error) {
        if (error instanceof WorkspaceFileError)
          return fail(error.code, error.message, 'validation', 'not-applied');
        throw error;
      }
    },
  });
}
