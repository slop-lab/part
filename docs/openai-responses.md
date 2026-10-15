# OpenAI Responses adapter

`@part/plugins/providers/openai-responses` exports `createOpenAIResponsesAdapter()`.
Its adapter ID is `part/openai-responses` and its encoded protocol is
`openai.responses`. It is a portable plugin depending only on `@part/core`;
transport and authentication remain independently replaceable.

```js
import { createAgent } from '@part/plugins/agent';
import { createOpenAIResponsesAdapter } from '@part/plugins/providers/openai-responses';
import { bearerAuth, createFetchTransport } from '@part/core/model';

const endpoint = `${process.env.R4U_BASE_URL.replace(/\/$/, '')}/responses`;
const created = createAgent({
  model: {
    profile: {
      id: 'responses',
      revision: '1',
      adapterId: 'part/openai-responses',
      transportId: 'part/fetch',
      authStrategyId: 'bearer',
      model: process.env.R4U_MODEL ?? 'gpt-6-luna',
      endpoint,
      defaults: { max_output_tokens: 256 },
      capabilities: { revision: '1', entries: [] },
    },
    adapter: createOpenAIResponsesAdapter(),
    transport: createFetchTransport({ allowedOrigins: [new URL(endpoint).origin] }),
    auth: bearerAuth(async () => process.env.R4U_API_KEY),
  },
});
if (!created.ok) throw Error(created.error.message);
try {
  const result = await created.value.generate('Reply with HELLO.');
  if (!result.ok || result.value.phase !== 'completed') throw Error('Generation failed');
  console.log(result.value.result.content);
} finally {
  await created.value.dispose();
}
```

For multiple R4U routes, inject the configured `X-Router4u-Route` header through
the fetch transport's `fetch` option, as the [live smoke script](../scripts/smoke-provider.mjs)
does. The portable adapter itself does not read environment variables.

## Supported profile

Requests use explicit complete input history, `store: false` and streaming by
default. Set `defaults.stream: false` for JSON. Text and JSON fragments become text
messages with system/developer/user/assistant roles. Runtime tool advertisements
become Responses function tools, with `strict: false` so the adapter does not silently
strengthen the installed tool's schema. Local dispatcher validation still applies.
Tool calls retain `call_id`; results become `function_call_output` items. The
basic driver can execute multiple advertised calls and return their results in
subsequent model input.

Reasoning items, including summaries and encrypted content, are preserved as native
content with provider `part/openai-responses` and format version `1`. The default
`include` requests `reasoning.encrypted_content`. Matching native reasoning content
is re-encoded as input items; foreign provider/format content or a conflicting
explicit profile affinity fails encoding. This preserves supplied native payloads as
JSON data without promising server-side conversation state or cross-model portability.
Function-call native output is also available on `Model.ToolCall.native`; the basic
driver reconstructs explicit function calls using their call ID, name and arguments.

JSON responses require `status: completed`. SSE exposes text deltas but returns an
executable response only after `response.completed` and clean stream completion.
That event supplies the authoritative output and usage snapshot. Streamed text,
function arguments, item IDs and completed item snapshots must agree with it.
UTF-8 and LF/CRLF/CR frames may span arbitrary byte chunks. An optional `[DONE]`
marker is accepted after the completed event; it cannot replace that event.
Token usage maps `input_tokens`/`output_tokens`, with provider details preserved.

Failed/incomplete responses, malformed or unfinished tool arguments, duplicate
call/item identities, changed stream snapshots and truncated streams fail without
returning executable tool calls. Unsupported output items/events fail explicitly.
This initial profile rejects media, refusals, nonempty annotations/logprobs and
provider-hosted tools. It also rejects background execution, stored conversations,
`previous_response_id` and runtime continuation handles. Chat Completions options
such as `messages`, `stream_options` and `max_completion_tokens` cannot be reused;
use Responses options such as `max_output_tokens` and `reasoning` instead.

## Validation

`tests/openai-responses.test.mjs` covers byte fragmentation, multiple output items,
argument fragments, terminal/snapshot errors, unsupported content and invalid usage.
The [fixed tool-flow fixture](../fixtures/openai-responses/tool-flow.fixture.json)
records exact requests/responses for native reasoning replay through the actual
agent/gateway/fetch transport and dispatcher, in JSON and SSE modes. A truncated
variant proves the tool executes zero times without a successful terminal response.
These tests use a fixed fetch implementation and require no provider credentials.
The interactive Node mock remains a Chat Completions mock.

Run the opt-in live test with `npm run smoke:responses`. It uses the existing `.env`
R4U credentials, discovers protocol/model capabilities and caps the run at four
short requests: JSON text, SSE text and a two-request function-tool loop. Live R4U
verification with `gpt-6-luna` passed all three scenarios; see
[structured evidence](responses-smoke.evidence.json). This does not certify every
model or every Responses API capability. [Provider smoke](provider-smoke.md) explains
request bounds and usage accounting.

The wire mapping follows the official OpenAI [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
and [Responses streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
