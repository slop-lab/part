import { digest, fail, isJsonObject, ok } from '@slop-lab/part/contracts';
import type { Contracts, Model } from '@slop-lab/part/reference';
import { isReasoningItem } from './output.js';

export async function encodeResponses(
  invocation: Model.Invocation,
  profile: Model.Profile,
): Promise<Contracts.Result<Model.EncodedRequest>> {
  if (invocation.continuation || invocation.tools.some((tool) => tool.execution !== 'runtime'))
    return fail(
      'openai-responses.profile',
      'Continuation and provider-hosted tools are unsupported',
      'unsupported',
    );
  if (!isJsonObject(profile.defaults) || !isJsonObject(invocation.options))
    return fail('openai-responses.options', 'Defaults and options must be JSON objects');
  const options = { ...profile.defaults, ...invocation.options };
  if (
    [
      'model',
      'input',
      'tools',
      'previous_response_id',
      'conversation',
      'messages',
      'stream_options',
      'max_completion_tokens',
      'n',
      'prompt',
    ].some((key) => Object.hasOwn(options, key)) ||
    (options.stream !== undefined && typeof options.stream !== 'boolean') ||
    (options.store !== undefined && options.store !== false) ||
    (options.background !== undefined && options.background !== false)
  )
    return fail(
      'openai-responses.options',
      'Reserved fields, stateful requests and background execution are unsupported',
      'unsupported',
    );
  const input: Contracts.Json[] = [];
  for (const fragment of invocation.context.fragments) {
    if (fragment.kind === 'tool-call') {
      const args = fragment.content.find((part) => part.kind === 'json');
      if (
        !fragment.toolRelation ||
        args?.kind !== 'json' ||
        !isJsonObject(args.value) ||
        fragment.content.length !== 1
      )
        return fail('openai-responses.tool', 'Invalid function call fragment');
      input.push({
        type: 'function_call',
        call_id: fragment.toolRelation.callId,
        name: fragment.toolRelation.toolId,
        arguments: JSON.stringify(args.value),
      });
      continue;
    }
    let text = '';
    const role = fragment.role ?? 'user';
    const flush = () => {
      if (text)
        input.push(
          fragment.kind === 'tool-result'
            ? { type: 'function_call_output', call_id: fragment.toolRelation!.callId, output: text }
            : { role, content: text },
        );
      text = '';
    };
    if (fragment.kind === 'tool-result' && !fragment.toolRelation)
      return fail('openai-responses.tool', 'Tool result has no call ID');
    if (
      fragment.kind !== 'tool-result' &&
      !['system', 'developer', 'user', 'assistant'].includes(role)
    )
      return fail('openai-responses.role', 'Unsupported message role', 'unsupported');
    for (const part of fragment.content) {
      if (part.kind === 'text') text += part.text;
      else if (part.kind === 'json') text += JSON.stringify(part.value);
      else if (
        fragment.kind === 'message' &&
        role === 'assistant' &&
        part.kind === 'native' &&
        part.native.provider === 'part/openai-responses' &&
        part.native.formatVersion === '1' &&
        (!part.native.affinity || part.native.affinity.profile === profile.id) &&
        isReasoningItem(part.native.payload)
      ) {
        flush();
        input.push(part.native.payload);
      } else
        return fail(
          'openai-responses.content',
          'Media or foreign native content requires explicit projection',
          'unsupported',
        );
    }
    if (fragment.kind === 'tool-result' && !text)
      input.push({
        type: 'function_call_output',
        call_id: fragment.toolRelation!.callId,
        output: '',
      });
    else flush();
  }
  const body = new TextEncoder().encode(
    JSON.stringify({
      stream: true,
      include: ['reasoning.encrypted_content'],
      ...options,
      store: false,
      model: profile.model,
      input,
      ...(invocation.tools.length
        ? {
            tools: invocation.tools.map((tool) => ({
              type: 'function',
              name: tool.id,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            })),
          }
        : {}),
    }),
  );
  return ok({
    protocol: 'openai.responses',
    mediaType: 'application/json',
    body,
    digest: await digest(body),
    metadata: {},
    inspectionBoundary: 'outgoing-body',
  });
}
