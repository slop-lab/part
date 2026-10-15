import { digest, fail, isJson, isJsonObject, ok } from '@part/core/contracts';
import type { Contracts, Model } from '@part/core/reference';

/** Ollama /api/chat NDJSON adapter; streaming text, thinking, and function tools. */
export function createOllamaAdapter(): Model.Adapter {
  return {
    id: 'part/ollama',
    async encode(invocation, profile) {
      if (invocation.continuation)
        return fail(
          'ollama.continuation',
          'Ollama chat uses explicit messages; continuation tokens are unsupported',
          'unsupported',
        );
      if (invocation.tools.some((tool) => tool.execution !== 'runtime'))
        return fail(
          'ollama.hosted-tools',
          'Hosted tools are unsupported by this adapter',
          'unsupported',
        );
      const messages: Contracts.Json[] = [];
      for (const fragment of invocation.context.fragments) {
        let content = '',
          thinking = '';
        for (const part of fragment.content) {
          if (part.kind === 'text') content += part.text;
          else if (part.kind === 'json') content += JSON.stringify(part.value);
          else if (
            part.kind === 'native' &&
            part.native.provider === 'part/ollama' &&
            isJsonObject(part.native.payload) &&
            typeof part.native.payload.thinking === 'string'
          )
            thinking += part.native.payload.thinking;
          else
            return fail(
              'ollama.content',
              'Unsupported media or native content; explicit projection is required',
              'unsupported',
            );
        }
        const message: Record<string, Contracts.Json> = { role: fragment.role ?? 'user', content };
        if (thinking) message.thinking = thinking;
        if (fragment.kind === 'tool-call') {
          const callPart = fragment.content.find((p) => p.kind === 'json');
          if (
            !fragment.toolRelation ||
            callPart?.kind !== 'json' ||
            typeof callPart.value !== 'object' ||
            callPart.value === null ||
            Array.isArray(callPart.value)
          )
            return fail('ollama.tool-call', 'Invalid tool call fragment');
          message.tool_calls = [
            { function: { name: fragment.toolRelation.toolId, arguments: callPart.value } },
          ];
          message.content = '';
        }
        if (fragment.kind === 'tool-result') message.tool_name = fragment.toolRelation!.toolId;
        messages.push(message);
      }
      if (
        !isJson(invocation.options) ||
        typeof invocation.options !== 'object' ||
        invocation.options === null ||
        Array.isArray(invocation.options)
      )
        return fail('ollama.options', 'Options must be an object');
      if (
        !isJson(profile.defaults) ||
        typeof profile.defaults !== 'object' ||
        profile.defaults === null ||
        Array.isArray(profile.defaults)
      )
        return fail('ollama.defaults', 'Defaults must be an object');
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: profile.model,
          messages,
          stream: true,
          options: { ...profile.defaults, ...invocation.options },
          ...(invocation.tools.length
            ? {
                tools: invocation.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.id, description: t.description, parameters: t.inputSchema },
                })),
              }
            : {}),
        }),
      );
      return ok({
        protocol: 'ollama.chat',
        mediaType: 'application/json',
        body,
        digest: await digest(body),
        metadata: {},
        inspectionBoundary: 'outgoing-body',
      });
    },
    createDecoder(response) {
      if (response.status && (response.status < 200 || response.status >= 300))
        return fail('ollama.http', `Provider returned HTTP ${response.status}`, 'unavailable');
      const utf8 = new TextDecoder('utf-8', { fatal: true });
      let buffered = '',
        text = '',
        thinking = '',
        terminal = false,
        poisoned: Contracts.Failure | undefined,
        finish: Contracts.Json = 'stop',
        usage: Model.Response['usage'] = {};
      const calls: Model.ToolCall[] = [];
      const decodeLine = (line: string): Contracts.Result<Model.ProviderEvent[]> => {
        if (!line.trim()) return ok([]);
        if (terminal) return fail('ollama.trailing', 'Data after terminal provider response');
        let chunk: unknown;
        try {
          chunk = JSON.parse(line);
        } catch {
          return fail('ollama.json', 'Malformed provider JSON');
        }
        if (!isJsonObject(chunk)) return fail('ollama.chunk', 'Invalid provider chunk');
        if (typeof chunk.error === 'string')
          return fail('ollama.error', 'Provider reported an error', 'unavailable');
        if (typeof chunk.done !== 'boolean') return fail('ollama.chunk', 'Missing completion flag');
        const message = chunk.message;
        if (!isJsonObject(message)) return fail('ollama.message', 'Missing response message');
        const events: Model.ProviderEvent[] = [];
        if (message.content !== undefined) {
          if (typeof message.content !== 'string')
            return fail('ollama.content', 'Invalid response content');
          text += message.content;
          if (message.content)
            events.push({ type: 'part.model/text', payload: { text: message.content } });
        }
        if (message.thinking !== undefined) {
          if (typeof message.thinking !== 'string')
            return fail('ollama.thinking', 'Invalid thinking payload');
          thinking += message.thinking;
        }
        if (message.tool_calls !== undefined) {
          if (!Array.isArray(message.tool_calls)) return fail('ollama.tools', 'Invalid tool calls');
          for (const call of message.tool_calls) {
            if (
              !isJsonObject(call) ||
              !isJsonObject(call.function) ||
              typeof call.function.name !== 'string' ||
              !call.function.arguments ||
              typeof call.function.arguments !== 'object' ||
              Array.isArray(call.function.arguments)
            )
              return fail('ollama.tool-arguments', 'Incomplete or invalid function arguments');
            calls.push({
              id: crypto.randomUUID(),
              toolId: call.function.name,
              arguments: call.function.arguments,
              native: { provider: 'part/ollama', formatVersion: '1', payload: call },
            });
          }
        }
        if (chunk.done) {
          terminal = true;
          finish = chunk.done_reason ?? 'stop';
          const input = chunk.prompt_eval_count,
            output = chunk.eval_count;
          if (
            (input !== undefined &&
              (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)) ||
            (output !== undefined &&
              (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0))
          )
            return fail('ollama.usage', 'Invalid token usage');
          usage = {
            ...(typeof input === 'number' ? { inputTokens: input } : {}),
            ...(typeof output === 'number' ? { outputTokens: output } : {}),
            providerNative: chunk,
          };
        }
        return ok(events);
      };
      const consume = (flush: boolean): Contracts.Result<Model.ProviderEvent[]> => {
        const events: Model.ProviderEvent[] = [];
        while (buffered.includes('\n') || (flush && buffered.length)) {
          const index = buffered.indexOf('\n'),
            line = index < 0 ? buffered : buffered.slice(0, index);
          buffered = index < 0 ? '' : buffered.slice(index + 1);
          const decoded = decodeLine(line);
          if (!decoded.ok) {
            poisoned = decoded.error;
            return decoded;
          }
          events.push(...decoded.value);
        }
        return ok(events);
      };
      return ok({
        push(chunk) {
          if (poisoned) return { ok: false, error: poisoned };
          try {
            buffered += utf8.decode(chunk, { stream: true });
          } catch {
            const r = fail('ollama.utf8', 'Malformed UTF-8');
            if (!r.ok) poisoned = r.error;
            return r;
          }
          return consume(false);
        },
        finish() {
          if (poisoned) return { ok: false, error: poisoned };
          try {
            buffered += utf8.decode();
          } catch {
            return fail('ollama.utf8', 'Incomplete UTF-8');
          }
          const flushed = consume(true);
          if (!flushed.ok) return flushed;
          if (!terminal) return fail('ollama.eof', 'Provider stream ended without completion');
          return ok({
            content: [
              { kind: 'text', text },
              ...(thinking
                ? [
                    {
                      kind: 'native' as const,
                      native: {
                        provider: 'part/ollama',
                        formatVersion: '1',
                        payload: { thinking },
                      },
                    },
                  ]
                : []),
            ],
            toolCalls: calls,
            finish: {
              normalized: calls.length
                ? 'tool-calls'
                : typeof finish === 'string'
                  ? finish
                  : 'unknown',
              native: finish,
            },
            usage,
          });
        },
      });
    },
  };
}
