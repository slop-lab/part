# CAR

CAR is the repository's initial single-workspace software-engineering profile.
It composes the `part` runtime, coding driver, bounded workspace/process tools,
durable local history, authenticated HTTP/SSE, and a browser workbench. It is a
private workspace application, not another SDK package.

Node.js 24.22.0 or newer is required. From the repository root:

```sh
npm ci
npm run car:build
mkdir -m 700 /tmp/car-state
npm run car -- serve \
  --root /absolute/path/to/workspace \
  --state /tmp/car-state \
  --mock-session /tmp/car-model-session.json \
  --workflows true
```

Use a new `--mock-session` filename. Startup prints one JSON object containing
the browser `url`, bearer `token`, canonical workspace `root`, local mock control
credentials, and `"dim":"disabled"`. Open the URL, enter the token, and drive
each pending model request with the existing mock CLI:

```sh
npm run mock:provider -- pending --session /tmp/car-model-session.json --wait-ms 1000
npm run mock:provider -- inspect --session /tmp/car-model-session.json --id REQUEST_ID
npm run mock:provider -- respond --session /tmp/car-model-session.json \
  --id REQUEST_ID --decision-id operator/final --text 'The requested result'
```

The default `interactive` provider makes no paid or upstream model call. Stop
CAR with `SIGINT` or `SIGTERM`. `npm run car:demo` runs the local HTTP/SSE,
hash-edit, process, cancellation, and history-reopen demonstration.

## Other useful invocations

```sh
# Host-selected completion validation; argv is ordinary JSON.
npm run car -- serve --root /abs/repo --state /private/state \
  --check '["npm","test"]'

# Exact-string rather than hash-addressed edits.
npm run car -- serve --root /abs/repo --state /private/state \
  --edit-mode exact

# Explicit recovery only after the old owner has exited.
npm run car -- recover-lock --state /private/state

# A generic OpenAI-compatible Responses endpoint. The base URL shown is the default.
OPENAI_API_KEY=set-locally OPENAI_MODEL=model-id npm run car -- serve \
  --root /abs/repo --state /private/state --provider responses \
  --base-url https://api.openai.com/v1 --headers '{"x-project":"example"}'
```

`--check` accepts a nonempty JSON argv array. Its first element must be either a
host-resolved alias (`node`, and any found `git`, `npm`, `npx`, or `pnpm`) or an
absolute executable path; no shell command string is accepted. Provider secrets
are not copied into the process environment. Real `chat` and `responses` modes
require an explicit model and `OPENAI_API_KEY`; `OPENAI_BASE_URL` defaults to
`https://api.openai.com/v1`. Generic headers may instead be supplied as an
`OPENAI_HEADERS` JSON string. They cannot override `Authorization`,
`Content-Type`, `Host`, `Content-Length`, or `Connection`. No paid-model call is
claimed by the repository's local verification.

For the complete CLI, embedded API, operator-session walkthrough, workflow
format, inspector queries, integration evidence, security properties, and
explicit non-goals, read [the standalone CAR guide](../docs/car.md).
