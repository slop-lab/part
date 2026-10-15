# Live provider smoke

Run `npm run smoke:provider` from the workspace root. This opt-in command reads
`R4U_API_KEY` and `R4U_BASE_URL` from `.env`; that file is ignored by Git. It is
separate from the credential-free test suite. Set `R4U_MODEL` to select a text/tool
model (default `gpt-6-luna`) and `R4U_ROUTE` if multiple project routes exist.
`R4U_BASE_URL` is the API base, normally ending in `/v1`.

The command checks `/capabilities` and `/models` before inference. The selected
route must advertise `chat`. It then runs the actual part agent, OpenAI-compatible
adapter, bearer authentication and fetch transport through JSON text, SSE text,
and a two-request SSE function-tool loop. Assertions cover HTTP/media types, exact
text, tool execution, request counts and final-response token usage. It allows at
most four completion requests, 256 requested completion tokens per request, one
tool dispatch, per-request timeouts and per-run deadlines. These bounds are not a
provider billing guarantee. There are no automatic inference retries. Output
contains verification metadata without credentials, endpoint URLs or upstream error
bodies. Per-case usage is from the final response, not aggregate billing.

## Current result

The supplied credentials authenticated successfully against the local R4U service:

- `GET /v1/models`: HTTP 200, 14 advertised models.
- `GET /v1/capabilities`: HTTP 200, one route, backend version `8.0.28`, profile
  `codex`, protocols `["responses"]`, streaming enabled.
- Four attempted Chat Completions requests (one through the part agent and three
  direct diagnostic requests) returned HTTP 400. The structured router error was
  `unsupported_capability`: `Protocol is not supported on this route`.
- The attempts covered `gpt-6-luna`, `gpt-5.5` and `gpt-6.1-sol`. They do not establish
  anything about upstream model entitlement or successful provider execution.
- The final smoke command exits nonzero at capability discovery, before inference.
  A missing compatible route is a failed precondition, never a passing smoke.

The provider smoke is **blocked**, replacing the previous user-requested deferral.
G-BASE remains open. Completion requires a project route supporting Chat Completions
or a separately implemented and tested Responses adapter. R4U documents these as
separate protocols; changing only the URL or model does not translate their payloads
or streaming events. No R4U configuration was modified. Ollama, hosted CI and actual
browser/device validation remain separate from this attempt.
