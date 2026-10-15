import { digest, fail, isJsonObject, ok } from '@part/core/contracts';
import type { Contracts, Model } from '@part/core/reference';
export async function encodeChat(
  invocation: Model.Invocation,
  profile: Model.Profile,
): Promise<Contracts.Result<Model.EncodedRequest>> {
  if (invocation.continuation || invocation.tools.some((tool) => tool.execution !== 'runtime'))
    return fail(
      'openai-compatible.profile',
      'Continuation tokens and provider-hosted tools are unsupported',
      'unsupported',
    );
  if (!isJsonObject(profile.defaults) || !isJsonObject(invocation.options))
    return fail('openai-compatible.options', 'Defaults and options must be JSON objects');
  const options = { ...profile.defaults, ...invocation.options };
  if (
    ['model', 'messages', 'tools'].some((key) => Object.hasOwn(options, key)) ||
    (options.n !== undefined && options.n !== 1) ||
    (options.stream !== undefined && typeof options.stream !== 'boolean')
  )
    return fail(
      'openai-compatible.options',
      'Reserved request fields or multiple choices are unsupported',
      'unsupported',
    );
  const messages: Contracts.Json[] = [];
  for (const fragment of invocation.context.fragments) {
    let content = '';
    for (const part of fragment.content) {
      if (part.kind === 'text') content += part.text;
      else if (part.kind === 'json') content += JSON.stringify(part.value);
      else
        return fail(
          'openai-compatible.content',
          'Media/native content requires an explicit projection',
          'unsupported',
        );
    }
    const message: Record<string, Contracts.Json> = { role: fragment.role ?? 'user', content };
    if (fragment.kind === 'tool-call') {
      const args = fragment.content.find((part) => part.kind === 'json');
      if (!fragment.toolRelation || args?.kind !== 'json')
        return fail('openai-compatible.tool', 'Invalid tool call fragment');
      message.content = null;
      message.tool_calls = [
        {
          id: fragment.toolRelation.callId,
          type: 'function',
          function: { name: fragment.toolRelation.toolId, arguments: JSON.stringify(args.value) },
        },
      ];
    }
    if (fragment.kind === 'tool-result') {
      if (!fragment.toolRelation)
        return fail('openai-compatible.tool', 'Tool result has no call ID');
      message.tool_call_id = fragment.toolRelation.callId;
    }
    messages.push(message);
  }
  const body = new TextEncoder().encode(
    JSON.stringify({
      stream: true,
      ...(options.stream === false ? {} : { stream_options: { include_usage: true } }),
      ...options,
      model: profile.model,
      messages,
      ...(invocation.tools.length
        ? {
            tools: invocation.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.id,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
    }),
  );
  return ok({
    protocol: 'openai.chat.completions',
    mediaType: 'application/json',
    body,
    digest: await digest(body),
    metadata: {},
    inspectionBoundary: 'outgoing-body',
  });
}
