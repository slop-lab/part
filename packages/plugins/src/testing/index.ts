import { ok } from '@slop-lab/part/contracts';
import { noAuth } from '@slop-lab/part/model';
import type { Contracts, Convenience, Model } from '@slop-lab/part/reference';
import { createOllamaAdapter } from '../providers/ollama.js';
export function fakeModel(
  replies: readonly {
    text?: string;
    toolCalls?: readonly { name: string; arguments: Contracts.Json }[];
    thinking?: string;
    error?: string;
    incomplete?: boolean;
  }[],
): Convenience.ConfiguredModel & { readonly requests: Model.EncodedRequest[] } {
  let index = 0;
  const requests: Model.EncodedRequest[] = [];
  return {
    profile: {
      id: 'fake',
      revision: '1',
      adapterId: 'part/ollama',
      transportId: 'part/fake',
      authStrategyId: 'none',
      model: 'fixture',
      defaults: {},
      capabilities: { revision: '1', entries: [] },
    },
    adapter: createOllamaAdapter(),
    auth: noAuth,
    transport: {
      id: 'part/fake',
      async send(request) {
        requests.push({ ...request, body: Uint8Array.from(request.body) });
        const reply = replies[index++] ?? { error: 'No fake reply remaining' };
        return ok({
          status: 200,
          headers: {},
          body: (async function* () {
            if (reply.error) {
              yield new TextEncoder().encode(JSON.stringify({ error: reply.error }) + '\n');
              return;
            }
            if (reply.text)
              for (const character of reply.text)
                yield new TextEncoder().encode(
                  JSON.stringify({
                    message: { role: 'assistant', content: character },
                    done: false,
                  }) + '\n',
                );
            if (reply.incomplete) return;
            yield new TextEncoder().encode(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  ...(reply.thinking ? { thinking: reply.thinking } : {}),
                  ...(reply.toolCalls
                    ? { tool_calls: reply.toolCalls.map((call) => ({ function: call })) }
                    : {}),
                },
                done: true,
                done_reason: 'stop',
              }) + '\n',
            );
          })(),
        });
      },
    },
    requests,
  };
}
