import { digest, fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';

export async function encodeMessages(
  invocation: Model.Invocation,
  profile: Model.Profile,
): Promise<Contracts.Result<Model.EncodedRequest>> {
  if (invocation.continuation || invocation.tools.some((tool) => tool.execution !== 'runtime'))
    return fail(
      'anthropic.profile',
      'Continuation and hosted tools are unsupported',
      'unsupported',
    );
  if (!isJsonObject(profile.defaults) || !isJsonObject(invocation.options))
    return fail('anthropic.options', 'Defaults and options must be JSON objects');
  const options = { stream: true, max_tokens: 1024, ...profile.defaults, ...invocation.options };
  if (
    ['model', 'messages', 'tools', 'system'].some((key) => Object.hasOwn(options, key)) ||
    typeof options.stream !== 'boolean' ||
    typeof options.max_tokens !== 'number' ||
    !Number.isSafeInteger(options.max_tokens) ||
    options.max_tokens < 1
  )
    return fail('anthropic.options', 'Reserved fields or invalid stream/max_tokens');

  const messages: { role: 'user' | 'assistant'; content: Contracts.Json[] }[] = [];
  const system: string[] = [];
  function append(role: 'user' | 'assistant', block: Contracts.Json) {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(block);
    else messages.push({ role, content: [block] });
  }
  for (const fragment of invocation.context.fragments) {
    if (fragment.kind === 'tool-call') {
      const part = fragment.content[0];
      if (
        fragment.content.length !== 1 ||
        part?.kind !== 'json' ||
        !isJsonObject(part.value) ||
        !fragment.toolRelation
      )
        return fail('anthropic.tool', 'Invalid tool call fragment');
      append('assistant', {
        type: 'tool_use',
        id: fragment.toolRelation.callId,
        name: fragment.toolRelation.toolId,
        input: part.value,
      });
      continue;
    }
    let text = '';
    for (const part of fragment.content) {
      if (part.kind === 'text') text += part.text;
      else if (part.kind === 'json') text += JSON.stringify(part.value);
      else
        return fail(
          'anthropic.content',
          'Media and native content require explicit projection',
          'unsupported',
        );
    }
    if (fragment.kind === 'tool-result') {
      if (!fragment.toolRelation) return fail('anthropic.tool', 'Tool result has no call ID');
      append('user', {
        type: 'tool_result',
        tool_use_id: fragment.toolRelation.callId,
        content: text,
      });
      continue;
    }
    const role = fragment.role ?? 'user';
    if (role === 'system' || role === 'developer') system.push(text);
    else if (role === 'user' || role === 'assistant') {
      if (text) append(role, { type: 'text', text });
    } else return fail('anthropic.role', 'Unsupported message role', 'unsupported');
  }
  const body = new TextEncoder().encode(
    JSON.stringify({
      ...options,
      model: profile.model,
      messages,
      ...(system.length ? { system: system.join('\n\n') } : {}),
      ...(invocation.tools.length
        ? {
            tools: invocation.tools.map((tool) => ({
              name: tool.id,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
    }),
  );
  return ok({
    protocol: 'anthropic.messages',
    mediaType: 'application/json',
    body,
    digest: await digest(body),
    metadata: {},
    inspectionBoundary: 'outgoing-body',
  });
}
