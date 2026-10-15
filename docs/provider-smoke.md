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
