# OpenAI Responses adapter

`@slop-lab/part-plugins/providers/openai-responses/index.js` exports `createOpenAIResponsesAdapter()`.
Its adapter ID is `part/openai-responses` and its encoded protocol is
`openai.responses`. It is a portable plugin depending only on `@slop-lab/part`;
transport and authentication remain independently replaceable.

```js
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses/index.js';
import { bearerAuth, createFetchTransport } from '@slop-lab/part/model/index.js';

const { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } = process.env;
if (!OPENAI_API_KEY || !OPENAI_BASE_URL || !OPENAI_MODEL) throw Error('Provider is not configured');
const base = new URL(OPENAI_BASE_URL);
if (
  !['http:', 'https:'].includes(base.protocol) ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
)
  throw Error('Invalid OPENAI_BASE_URL');
base.pathname = base.pathname.replace(/\/$/, '').replace(/\/responses$/, '');
const endpoint = `${base}/responses`;
const created = createAgent({
  model: {
    profile: {
      id: 'responses',
      revision: '1',
      adapterId: 'part/openai-responses',
      transportId: 'part/fetch',
      authStrategyId: 'bearer',
      model: OPENAI_MODEL,
      endpoint,
      defaults: { max_output_tokens: 256 },
      capabilities: { revision: '1', entries: [] },
    },
    adapter: createOpenAIResponsesAdapter(),
    transport: createFetchTransport({ allowedOrigins: [new URL(endpoint).origin] }),
    auth: bearerAuth(async () => OPENAI_API_KEY),
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

For provider-specific routing or tenancy metadata, set `OPENAI_HEADERS` to a JSON
object with string values. The runnable examples validate and inject those headers
through the fetch transport while forbidding overrides of authentication, content
framing and connection headers. The portable adapter itself does not read environment variables.

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
The model gateway normalizes text fragments to `part.model/text` progress events
with `text` and `modelCallId`. It combines adjacent fragments from the same transport
chunk. This gives embedded hosts and clients the same event across Chat Completions,
Responses, Anthropic Messages and Ollama. Direct adapter decoders continue to expose
their provider event types.
Token usage maps `input_tokens`/`output_tokens`, with provider details preserved.

Failed/incomplete responses, malformed or unfinished tool arguments, duplicate
call/item identities, changed stream snapshots and truncated streams fail without
returning executable tool calls. The decoder accepts queued lifecycle events and
ignores keepalives and auxiliary Responses event types. Recognized output events
and the final output snapshot are still validated. Text annotations and log
probabilities are treated as metadata when projecting text. Media, refusals and
provider-hosted output items remain unsupported. Stream errors expose the relevant
event type and provider request ID when available. It also rejects background execution, stored conversations,
`previous_response_id` and runtime continuation handles. Chat Completions options
such as `messages`, `stream_options` and `max_completion_tokens` cannot be reused;
use Responses options such as `max_output_tokens` and `reasoning` instead.

## Validation

`tests/openai-responses.test.ts` covers byte fragmentation, multiple output items,
argument fragments, terminal/snapshot errors, unsupported content and invalid usage.
The [fixed tool-flow fixture](../fixtures/openai-responses/tool-flow.fixture.json)
used by `tests/openai-responses-tool-flow.test.ts`
records exact requests/responses for native reasoning replay through the actual
agent/gateway/fetch transport and dispatcher, in JSON and SSE modes. A truncated
variant proves the tool executes zero times without a successful terminal response.
These tests use a fixed fetch implementation and require no provider credentials.
The interactive Node mock remains a Chat Completions mock.

Run the opt-in live test with `npm run smoke:responses`. It uses the existing `.env`
OpenAI-compatible settings and caps the run at four short requests: JSON text, SSE
text and a two-request function-tool loop. It directly exercises the explicitly
configured model rather than relying on proprietary capability discovery.
[Provider smoke](provider-smoke.md) explains request bounds and usage accounting.
Run this check against your configured model; support varies by provider and model.

The wire mapping follows the official OpenAI [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
and [Responses streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
