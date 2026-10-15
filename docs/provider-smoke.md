# Live provider smoke

Run `npm run smoke:provider` from the workspace root. This opt-in command reads
`R4U_API_KEY` and `R4U_BASE_URL` from `.env`; that file is ignored by Git. It is
separate from the credential-free test suite. Set `R4U_MODEL` to select a text/tool
model (default `gpt-6-luna`) and `R4U_ROUTE` if multiple project routes exist.
Use `npm run smoke:responses` for the separate [Responses adapter](openai-responses.md).
`R4U_BASE_URL` is the API base, normally ending in `/v1`.

The command checks `/capabilities` and `/models` before inference. The selected
route must advertise `chat` or `responses`, matching the chosen command. It then
runs the actual part agent, selected provider
adapter, bearer authentication and fetch transport through JSON text, SSE text,
and a two-request SSE function-tool loop. Assertions cover HTTP/media types, exact
text, tool execution, request counts and final-response token usage. It allows at
most four model requests, 256 requested output tokens per request, one
tool dispatch, per-request timeouts and per-run deadlines. These bounds are not a
provider billing guarantee. There are no automatic inference retries. Output
contains verification metadata without credentials, endpoint URLs or upstream error
bodies. Per-case usage is from the final response, not aggregate billing.

## Current result

**Passed** on 2026-10-15 with `gpt-6-luna` through the user-configured R4U
Chat Completions route, source revision `55cbf5c`. See the credential-free
[structured evidence](provider-smoke.evidence.json).

| Scenario          | Completion requests | Result                                                                                     | Final response usage (input/output) |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| Text JSON         | 1                   | HTTP 200, `application/json`, `HELLO`                                                      | 308 / 6                             |
| Text SSE          | 1                   | HTTP 200, `text/event-stream`, `HELLO`                                                     | 308 / 6                             |
| Function tool SSE | 2                   | Both HTTP 200; `uppercase("hello")` executed once, result returned to model, final `HELLO` | 401 / 6                             |

All three cases ran through the actual part agent, adapter, bearer authentication
and fetch transport. Capability discovery accepted `chat`, and model discovery
returned 14 entries. Final-response token usage was present in every case.
The four completion requests here exclude the earlier diagnostic attempts below.
Tool-case usage covers its final response only, not its first tool-call response.

This closes the missing real-provider/custom-endpoint evidence for the selected
G-BASE reference profile. It does not certify all R4U models, Responses, media,
provider-hosted tools, upstream billing guarantees or production recovery. Ollama,
hosted CI and actual browser/device validation remain separate. No R4U configuration
or credentials were modified by this workspace.

## Responses result

The separate Responses smoke also passed with `gpt-6-luna` on the same configured
service: JSON text, SSE text and one actual function execution followed by the final
model response, all four requests HTTP 200. See [Responses evidence](responses-smoke.evidence.json)
for timestamp, source revision and final-response usage. Each protocol is tested
through its own encoding/decoding implementation. Chat smoke does not establish
Responses compatibility, and Responses smoke does not expand the Node mock profile.

## Earlier attempts and compatibility fix

The first supplied route advertised Responses only and rejected four Chat
Completions requests across `gpt-6-luna`, `gpt-5.5` and `gpt-6.1-sol` with HTTP 400
`unsupported_capability`. After the user enabled Chat Completions, the first part
request reached HTTP 200 but exposed a decoder incompatibility: the router returns
`tool_calls: null` for a text-only response. A direct diagnostic request confirmed
that response shape and successful `HELLO` output.

The decoder now treats null tool calls as absent. JSON and SSE regression cases
accept null while continuing to reject malformed non-null tool calls. After that
fix the full four-request smoke passed. The original route mismatch is resolved;
the earlier failed attempts remain in the validation log as historical evidence.
