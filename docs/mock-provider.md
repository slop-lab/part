# Agent-operated and fixed mock providers

The local mock implements a text/function-tool subset of the
[official OpenAI Chat Completions protocol](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
A client sends normal requests to `POST /v1/chat/completions`, with JSON or SSE
responses. `GET /v1/models` is also available. No upstream provider is called.
The working agent decides interactive responses using project context and the
captured request; fixed mode uses exact ordered fixture exchanges.

Implementation ownership stays explicit: the service, CLI and operator tools are
in `@part/node`; the portable Chat Completions adapter is in
`@part/plugins/providers/openai-compatible`. Core and browser packages do not
acquire Node dependencies.

## Interactive flow for a working agent

Build once, then start a session in a terminal or an agent-owned background process:

```sh
npm run build
npm run mock:provider -- serve --mode interactive --project my-project \
  --root /path/to/project --scenario 'Verify the agent tool loop' \
  --session /tmp/part-mock-session.json --transcript /tmp/part-mock-transcript.json
```

Use a new session filename: creation is exclusive with mode `0600`. The JSON
session descriptor contains `baseURL`, `apiKey`, `controlURL`, `controlToken` and
project metadata. Use `baseURL` as an OpenAI-compatible client's base URL and
`apiKey` as its local dummy API key. With the usual environment-based client
configuration, these values correspond to `OPENAI_BASE_URL` and `OPENAI_API_KEY`.
They are mock-session credentials, not real-provider credentials.

For the supplied example, start the requesting agent in another process:

```sh
node examples/mock-provider/request.mjs /tmp/part-mock-session.json
```

The requesting process waits. The working agent uses its shell tool to inspect
the pending request and choose a reply:

```sh
npm run mock:provider -- pending --session /tmp/part-mock-session.json --wait-ms 1000
npm run mock:provider -- inspect --session /tmp/part-mock-session.json --id request-1
npm run mock:provider -- respond --session /tmp/part-mock-session.json \
  --id request-1 --decision-id operator/choose-tool \
  --reply fixtures/mock-provider/choose-tool.reply.json
```

This response asks the requesting agent to execute `uppercase`. Inspect the next
request, including its actual tool result, before choosing the final response:

```sh
npm run mock:provider -- pending --session /tmp/part-mock-session.json --wait-ms 1000
npm run mock:provider -- respond --session /tmp/part-mock-session.json \
  --id request-2 --decision-id operator/final --text HELLO
npm run mock:provider -- verify --session /tmp/part-mock-session.json
npm run mock:provider -- transcript --session /tmp/part-mock-session.json \
  --output /tmp/part-mock-transcript.json
```

The working agent reads project/request data and makes the decision. The server
neither evaluates prompts nor launches another model. CLI commands print JSON;
`--output` writes JSON to a file. Installed packages expose the same commands as
`part-mock-provider`, without the repository's `npm run mock:provider --` prefix.

## Register operator tools with an existing agent host

```js
import { readFile } from 'node:fs/promises';
import { createMockProviderClient, readMockSession } from '@part/node/testing/mock-provider';
import { createMockProviderTools } from '@part/node/testing/mock-provider/tools';

const session = readMockSession(JSON.parse(await readFile('/tmp/part-mock-session.json', 'utf8')));
const client = createMockProviderClient(session);
const { tools, toolSchemas } = createMockProviderTools(client);
// Register tools and their schemas with the working agent's existing host.
```

The supplied `InstalledTool` bindings are `mock_provider_status`,
`mock_provider_pending`, `mock_provider_inspect`, `mock_provider_respond`,
`mock_provider_transcript` and `mock_provider_verify`. They bind to one session;
tool inputs cannot change the control endpoint. The response tool is classified
as a write; inspection tools are reads. Pending observation honors cancellation.
Incoming requests are test data, not instructions governing the operator agent.

Responses are correlated by request ID. Repeating the same `decisionId` with the
same reply returns the existing decision. A changed reply or a second decision
for a terminal request fails. Responses for concurrent requests may be chosen in
any order without being swapped between clients.

## Freeze interactive decisions for noninteractive tests

Before stopping a successful session, export its exact requests and responses:

```sh
npm run mock:provider -- fixture --session /tmp/part-mock-session.json \
  --output /tmp/recorded.fixture.json
npm run mock:provider -- stop --session /tmp/part-mock-session.json
```

An exported transcript can also be converted offline:

```sh
npm run mock:provider -- fixture --transcript /tmp/part-mock-transcript.json \
  --output /tmp/recorded.fixture.json
```

`fixtureFromTranscript` provides the same operation in code. Conversion rejects
unanswered, cancelled, failed or incomplete transcripts. The fixture preserves
request bodies and replies, without session URLs or credentials. Fixed mode
compares the entire request JSON: object key order is irrelevant, array order and
all field values matter. A mismatch returns HTTP 409 without consuming the next
exchange. Extra requests, prior mismatches, capacity failures and unused exchanges
make `verify()` fail; later correct requests do not erase earlier failures.

Start a fixed endpoint for any OpenAI-compatible client:

```sh
npm run mock:provider -- serve --mode fixed --project my-project \
  --fixture /tmp/recorded.fixture.json --session /tmp/part-mock-fixed-session.json
```

For the complete automated part agent/tool flow and golden transcript comparison:

```sh
npm run example:mock:fixed
```

`examples/mock-provider/fixed.mjs` starts a fixed provider, runs a real part agent
through a function tool, asserts that the fixture was consumed, compares the full
transcript and closes its resources. Automatic tests exercise both modes and the
interactive-to-fixed conversion without operator input.

## Fixture and transcript files

- `fixtures/mock-provider/tool-flow.fixture.json`: exact request/reply exchanges.
- `fixtures/mock-provider/fixed-tool-flow.transcript.json`: fixed HTTP conversation,
  actual tool invocation/result and final agent output.
- `fixtures/mock-provider/interactive-tool-flow.transcript.json`: the same flow
  controlled through operator tools and explicit decision IDs.
- `fixtures/mock-provider/choose-tool.reply.json` and `final.reply.json`: example
  operator decisions, including tool-call arguments, text chunks and token usage.

Fixture format version 1 has `schemaVersion`, `name` and `exchanges`; each exchange
contains `id`, `request` and `reply`. Reply kinds are:

- `completion`: `content`, optional `toolCalls`, `textChunks`, `finishReason`, `usage`.
  Each tool call has `id`, `name` and JSON-encoded `arguments`.
- `error`: HTTP `status`, `message` and optional `code`.
- `raw`: HTTP `status`, `contentType` and `body`, for deliberate malformed-wire tests.

Completion replies follow the request's `stream` flag. SSE emits assistant/content/
function-call deltas, a terminal choice, optional requested usage and `[DONE]`.
Transcripts retain request bodies, chosen replies, terminal states, fixture/decision
IDs, outstanding fixture counts and failures. Transport credentials are excluded.
Golden fixtures use a stable project ID; CLI project roots are also captured when
provided, so CLI transcripts may contain machine-specific paths.

## Lifecycle and supported limits

Listeners bind only to `127.0.0.1`, with separate model/control credentials. Default
limits are 1 MiB request bodies, 4 MiB responses, 1,000 retained requests, 128 pending
requests and a five-minute response timeout. Control long polling is bounded to
30 seconds. Programmatic start options can change positive limits.

Disconnects and timeouts end pending requests. Late decisions fail, shutdown releases
pending clients, and verification records unresolved work as a failure. The CLI exits
nonzero for invalid commands, failed verification or incomplete shutdown. Explicit
error/raw fixture replies can still be successfully consumed test exchanges.
Session state and decisions are in memory; transcripts and exported fixtures are
explicit files, not crash recovery. There is no automatic retry or provider fallback.

The shipped compatibility profile covers one Chat Completions choice, text,
function tools, JSON/SSE and token usage. It does not implement Responses API,
Realtime, provider-hosted tools, media or continuation tokens. Unrecognized message
payload fields can be inspected/matched as JSON but are not executed by the mock.
The portable adapter rejects unsupported output/content and malformed/truncated
streams. No real-provider smoke success is claimed.
