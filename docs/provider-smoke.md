# Live provider smoke

Run `npm run smoke:provider` from the workspace root. This opt-in command reads
`OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_MODEL` from `.env`; that file is
ignored by Git. It is separate from the credential-free test suite. The model must
support text and function tools.
Use `npm run smoke:responses` for the separate [Responses adapter](openai-responses.md).
`OPENAI_BASE_URL` is the OpenAI-compatible API base, normally ending in `/v1`.
It must be an HTTP(S) URL without credentials, a query or a fragment.

Optional `OPENAI_HEADERS` is a JSON object whose values must all be strings, for
example `{"x-project":"example"}`. It cannot override `Authorization`,
`Content-Type`, `Host`, `Content-Length` or `Connection`. Redirects are rejected.
There is no proprietary capability-discovery request: the configured model and
selected Chat Completions or Responses protocol are exercised directly.

The command runs the actual part agent, selected provider
adapter, bearer authentication and fetch transport through JSON text, SSE text,
and a two-request SSE function-tool loop. Assertions cover HTTP/media types, exact
text, tool execution, request counts and final-response token usage. It allows at
most four model requests, 256 requested output tokens per request, one
tool dispatch, per-request timeouts and per-run deadlines. These bounds are not a
provider billing guarantee. There are no automatic inference retries. Output
contains verification metadata without credentials, custom headers, endpoint URLs
or upstream error bodies. Per-case usage is from the final response, not aggregate billing.
