// @ts-check
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { isJson } from '@slop-lab/part/contracts/index.js';
import { setTimeout } from 'node:timers/promises';
import {
  createChatGPTModel,
  createProviderModel,
  parseProviderHeaders,
} from '@slop-lab/part-plugins/providers/index.js';
import { createExampleOpenAIModel, hasOpenAIProvider } from '../openai-provider.mjs';

/** @param {NodeJS.ProcessEnv} environment */
export function providerOptions(environment = {}, siwc = false, plan = false) {
  return [
    { id: 'scripted', label: 'Scripted · no API key', available: true },
    {
      id: 'responses',
      label: 'OpenAI-compatible · Responses',
      available: hasOpenAIProvider(environment),
    },
    {
      id: 'chat',
      label: 'OpenAI-compatible · Chat Completions',
      available: hasOpenAIProvider(environment),
    },
    ...(environment.ANTHROPIC_API_KEY && environment.ANTHROPIC_MODEL
      ? [{ id: 'messages', label: 'Anthropic-compatible · Messages', available: true }]
      : []),
    ...(siwc ? [{ id: 'chatgpt', label: 'ChatGPT plan · Responses', available: plan }] : []),
  ];
}
/**
 * @typedef {import('@slop-lab/part/reference/index.js').Convenience.ConfiguredModel} ConfiguredModel
 * @param {{provider: string, scenario: string, prompt: string, model: string, environment: NodeJS.ProcessEnv, accessToken?: () => Promise<string>, fetch?: typeof fetch, trace: (kind: string, data: import('@slop-lab/part/reference/index.js').Contracts.Json) => void, delayScale?: number}} options
 * @returns {ConfiguredModel}
 */
export function createPlaygroundModel({
  provider,
  scenario,
  prompt,
  model,
  environment,
  accessToken,
  fetch: request,
  trace,
  delayScale = 1,
}) {
  /** @type {ConfiguredModel} */
  let configured;
  if (provider === 'scripted') {
    /** @type {Record<string, {name: string, arguments: import("@slop-lab/part/reference/index.js").Contracts.Json}>} */
    const tools = {
      tools: { name: 'uppercase', arguments: { text: prompt } },
      approval: { name: 'save_note', arguments: { text: prompt } },
      artifact: { name: 'create_report', arguments: { text: prompt } },
      failure: { name: 'uppercase', arguments: { text: 42 } },
    };
    const text =
      scenario === 'tools'
        ? `## Tool complete\n\n${prompt.toUpperCase()}\n\nThe dispatcher validated the input before executing **uppercase**.`
        : scenario === 'approval'
          ? '## Note saved\n\nYour approval released the waiting middleware. Open **Session note** to see the result.'
          : scenario === 'artifact'
            ? '## Report ready\n\nAn immutable Markdown artifact is available below. Select **Open report** to read or download it.'
            : scenario === 'cancellation'
              ? Array.from(
                  { length: 12 },
                  (_, i) =>
                    `### Step ${i + 1}\n\nManaged work keeps ownership, progress and cleanup explicit. Stop this run whenever you are ready.\n\n`,
                ).join('')
              : `## Small steps, visible progress\n\nYou asked: ${prompt}\n\nA progressive runtime connects **model requests**, **validated tools** and **observable execution**. Each part has a clear owner.\n\n- Watch a response as it streams.\n- Inspect what the model received.\n- Gate writes on an explicit approval.\n\nTry another example from the sidebar. This reply is scripted; the agent, dispatcher and client transport are real.`;
    const tool = tools[scenario];
    configured = fakeModel(tool ? [{ toolCalls: [tool] }, { text }] : [{ text }]);
    const original = configured.transport;
    configured = {
      ...configured,
      transport: {
        ...original,
        async send(request, profile, auth, context) {
          const sent = await original.send(request, profile, auth, context);
          if (sent.ok === false) return sent;
          return {
            ...sent,
            value: {
              ...sent.value,
              body: (async function* () {
                for await (const chunk of sent.value.body) {
                  if (context.signal.aborted) return;
                  if (delayScale)
                    await setTimeout(
                      (scenario === 'cancellation' ? 22 : 3) * delayScale,
                      undefined,
                      { signal: context.signal },
                    );
                  yield chunk;
                }
              })(),
            },
          };
        },
      },
    };
  } else if (provider === 'chatgpt' && accessToken) {
    configured = createChatGPTModel({ model, accessToken, timeoutMs: 90_000, fetch: request });
  } else if (
    provider === 'messages' &&
    environment.ANTHROPIC_API_KEY &&
    environment.ANTHROPIC_MODEL
  ) {
    configured = createProviderModel({
      protocol: 'messages',
      model,
      apiKey: environment.ANTHROPIC_API_KEY,
      baseURL: environment.ANTHROPIC_BASE_URL,
      headers: parseProviderHeaders(environment.ANTHROPIC_HEADERS),
      defaults: { max_tokens: 512 },
      timeoutMs: 90_000,
      fetch: request,
    });
  } else {
    if (!providerOptions(environment).some((entry) => entry.id === provider && entry.available))
      throw Error('Provider is not configured');
    configured = createExampleOpenAIModel(environment, {
      protocol: provider === 'responses' ? 'responses' : 'chat',
      model,
      fetch: request,
    });
  }
  const transport = configured.transport;
  return {
    ...configured,
    transport: {
      ...transport,
      async send(request, profile, auth, context) {
        /** @type {unknown} */
        const body = JSON.parse(new TextDecoder().decode(request.body));
        if (!isJson(body)) throw Error('Invalid encoded request JSON');
        trace('request', {
          protocol: request.protocol,
          digest: request.digest,
          body,
        });
        return transport.send(request, profile, auth, context);
      },
    },
  };
}
