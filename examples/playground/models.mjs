// @ts-check
import { createOpenAICompatibleAdapter } from '@slop-lab/part-plugins/providers/openai-compatible/index.js';
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';
import { isJson } from '@slop-lab/part/contracts/index.js';
import { bearerAuth, createFetchTransport } from '@slop-lab/part/model/index.js';
import { setTimeout } from 'node:timers/promises';
import {
  hasOpenAIProvider,
  openAIEndpoint,
  readOpenAIProvider,
  withOpenAIHeaders,
} from '../openai-provider.mjs';

/** @param {NodeJS.ProcessEnv} environment */
export function providerOptions(environment = {}) {
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
  ];
}
/**
 * @typedef {import('@slop-lab/part/reference/index.js').Convenience.ConfiguredModel} ConfiguredModel
 * @param {{provider: string, scenario: string, prompt: string, model: string, environment: NodeJS.ProcessEnv, trace: (kind: string, data: import('@slop-lab/part/reference/index.js').Contracts.Json) => void, delayScale?: number}} options
 * @returns {ConfiguredModel}
 */
export function createPlaygroundModel({
  provider,
  scenario,
  prompt,
  model,
  environment,
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
  } else {
    if (!providerOptions(environment).some((entry) => entry.id === provider && entry.available))
      throw Error('Provider is not configured');
    const adapter =
      provider === 'responses' ? createOpenAIResponsesAdapter() : createOpenAICompatibleAdapter();
    const { base, key, headers } = readOpenAIProvider(environment);
    configured = {
      profile: {
        id: provider,
        revision: '1',
        adapterId: adapter.id,
        transportId: 'part/fetch',
        authStrategyId: 'bearer',
        model,
        endpoint: openAIEndpoint(base, provider === 'responses' ? 'responses' : 'chat/completions'),
        defaults:
          provider === 'responses' ? { max_output_tokens: 512 } : { max_completion_tokens: 512 },
        capabilities: { revision: '1', entries: [] },
      },
      adapter,
      auth: bearerAuth(async () => key),
      transport: createFetchTransport({
        allowedOrigins: [base.origin],
        fetch(url, init = {}) {
          return fetch(url, {
            ...init,
            headers: withOpenAIHeaders(init.headers, headers),
            redirect: 'error',
            signal: AbortSignal.any([
              ...(init.signal ? [init.signal] : []),
              AbortSignal.timeout(90000),
            ]),
          });
        },
      }),
    };
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
