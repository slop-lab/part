# Implemented contracts

Version: `0.1.0`, experimental API profile. Node.js usage requires 24.22.0 or newer.
All concrete JavaScript APIs are generated from `packages/*/src/**/*.ts`. `@slop-lab/part/reference/index.js` is a
**type-only design reference**, including future optional contracts; it does not
mean every namespace has an implementation.

Public imports follow the source domains without compatibility aliases. Node
applications using `@slop-lab/part-node/host/http.js` need Node TypeScript typings because its
authentication callback receives an `IncomingMessage`. Portable entrypoints do
not require ambient Node types.

The workspace root is not an aggregate SDK. Core has no package dependencies;
plugins, Node and browser each depend only on the matching core version. Install
only the needed packages. Bridge interfaces are type-only exports from
`@slop-lab/part/scripts/bridge.js`; the portable implementation is in
`@slop-lab/part-plugins/scripts/bridge/index.js` and loopback transport is in `@slop-lab/part-node/scripts/bridge.js`.

| Export                                                                                                                                                   | Implemented surface                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@slop-lab/part`                                                                                                                                         | Small schema/composition/operation/boundary helpers                                                              |
| `@slop-lab/part/contracts/index.js`                                                                                                                      | Results/errors, runtime schemas, strict JSON codecs, local invocation contexts                                   |
| `@slop-lab/part/composition/index.js`                                                                                                                    | Planner, exact requirements, ordering, replacement, service factories, scopes/rollback                           |
| `@slop-lab/part/runtime/index.js`                                                                                                                        | Independent handles, best-effort observation/gaps, attached operations, cancellation, budgets, awaited attempts  |
| `@slop-lab/part/runtime/runs.js`                                                                                                                         | Validated installed drivers and run service                                                                      |
| `@slop-lab/part-plugins/agent/index.js`                                                                                                                  | Typed embedded agent; `expandAgent` exposes manual composition                                                   |
| `@slop-lab/part-plugins/agent/drivers/basic.js`                                                                                                          | Own model/tool loop and a post-stop validating driver                                                            |
| `@slop-lab/part/model/index.js`                                                                                                                          | Gateway, request transforms/inspection, fetch transport, explicit authentication strategies                      |
| `@slop-lab/part-plugins/providers/index.js`                                                                                                              | Model configuration for Chat Completions, Responses, Anthropic Messages and ChatGPT plan usage                   |
| `@slop-lab/part-node/siwc/index.js`                                                                                                                      | Sign in with ChatGPT, renewable plan sessions and Codex app-server credentials                                   |
| `@slop-lab/part-plugins/providers/ollama.js`                                                                                                             | Strict Ollama chat NDJSON subset                                                                                 |
| `@slop-lab/part/tools.js`                                                                                                                                | Installed function bindings, external executor port, six middleware decisions                                    |
| `@slop-lab/part/context/index.js`                                                                                                                        | Planner/resolver/lowerer/transforms/assembler, source versions/maps and digests                                  |
| `@slop-lab/part/context/history.js`                                                                                                                      | Immutable records, branch CAS, forks and path reads; memory or supplied store                                    |
| `@slop-lab/part/context/projection.js`                                                                                                                   | Authorized projector dispatch; unknown types use a payload-free fallback                                         |
| `@slop-lab/part/storage/memory.js`                                                                                                                       | Atomic state/journal, CAS, change-ID dedupe, committed command receipts                                          |
| `@slop-lab/part-node/storage/sqlite.js`                                                                                                                  | Explicit local SQLite open/close; durable atomic state/journal snapshots                                         |
| `@slop-lab/part/storage/runtime.js`                                                                                                                      | Durable intent/settlement boundary and explicit unknown/abandoned recovery                                       |
| `@slop-lab/part/client/control.js`                                                                                                                       | Schema-validated owner action/query bindings and memory command dedupe                                           |
| `@slop-lab/part/client/index.js`                                                                                                                         | Local/codec-loopback port, snapshot/watch hub, normalized controller, UTF-16 deltas                              |
| `@slop-lab/part/host/embedded.js`                                                                                                                        | Principal-owned start/cancel/get/actions/composition/capability endpoint                                         |
| `@slop-lab/part-node/host/http.js`, `@slop-lab/part/client/http.js`                                                                                      | Explicit authenticated context injection, HTTP commands/queries, bounded SSE observation                         |
| `@slop-lab/part-browser/headless.js`, `@slop-lab/part-browser/dom.js`, `@slop-lab/part-browser/styles.css`                                               | Composer/scroll controllers, themed Chat, safe Markdown, DOM components and ordered slots                        |
| `@slop-lab/part/results/index.js`                                                                                                                        | Pinned result sources, schema/processor profiles, bounded processing and submission dedupe                       |
| `@slop-lab/part-node/scripts/index.js`                                                                                                                   | Explicit standalone scripts, fixed source bytes, argv/JSON stdin, bounded JSON capture, process-tree termination |
| `@slop-lab/part-node/packages.js`, `@slop-lab/part-plugins/extensions/skills.js`                                                                         | Explicit directory snapshots and restricted SKILL.md reader/activation; no executable loading                    |
| `@slop-lab/part-plugins/extensions/hooks.js`                                                                                                             | Validated script hook points, awaited enforcement, once/scope/reentrancy handling                                |
| `@slop-lab/part-plugins/workflows/host.js`                                                                                                               | Engine selection, format/capability/control checks and native submission forwarding                              |
| `@slop-lab/part-plugins/workflows/code.js`                                                                                                               | Explicitly registered trusted async code, managed calls, memory wait, schema completion                          |
| `@slop-lab/part-plugins/workflows/pipeline/index.js`                                                                                                     | Lexical sequential/branch/repeat/parallel, managed script/agent, validation and waits                            |
| `@slop-lab/part-plugins/workflows/memory/index.js`                                                                                                       | Reference engine lifecycle, bounded managed calls, fixed prepared handles and memory submission dedupe           |
| `@slop-lab/part/runtime/budgets.js`, `@slop-lab/part/runtime/costs.js`                                                                                   | Parent/local budget composition and explicit decimal model-cost estimates                                        |
| `@slop-lab/part/artifacts/index.js`, `@slop-lab/part-node/artifacts.js`                                                                                  | Finalized immutable memory/file artifacts, authorized bounded range reads                                        |
| `@slop-lab/part/context/run-history.js`                                                                                                                  | Explicit run attachment, branch writer/CAS checks and chat record projection                                     |
| `@slop-lab/part/storage/migrations.js`                                                                                                                   | Explicit namespace migration with atomic schema publication and failure ledger                                   |
| `@slop-lab/part-plugins/workflows/checkpoints.js`                                                                                                        | Authorized CAS checkpoint storage; scheduling and resume remain engine-owned                                     |
| `@slop-lab/part/host/runtime.js`, `@slop-lab/part/host/resources.js`                                                                                     | Priority admission, pending replacement, drain/cancel and resource transfer/cleanup                              |
| `@slop-lab/part-plugins/scripts/bridge/index.js`, `@slop-lab/part-node/scripts/bridge.js`, `@slop-lab/part-plugins/scripts/bridge/services.js`           | Authenticated loopback grants, host-selected methods, budgets, expiry and revocation                             |
| `@slop-lab/part-plugins/workflows/endpoint.js`, `@slop-lab/part-browser/workflow.js`                                                                     | Registered wire definitions, authorized generic results/waits/actions and default forms                          |
| `@slop-lab/part-plugins/workflows/external.js`, `@slop-lab/part-plugins/workflows/agent-step.js`                                                         | Native submit/attach/reconcile and stable-key managed agent attachment                                           |
| `@slop-lab/part-plugins/workflows/recipe.js`                                                                                                             | Explicit read-only whole-agent validation retry, independent of checkpoint resume                                |
| `@slop-lab/part-browser/registry.js`, `@slop-lab/part-browser/markdown.js`, `@slop-lab/part-browser/inspector.js`, `@slop-lab/part-browser/workbench.js` | Public presentation registries, safe Markdown, inspector, artifacts and layout                                   |
| `@slop-lab/part/runtime/observability.js`                                                                                                                | Immutable manifests, explicit trace/redaction policy, bounded retention and authorized reads                     |
| `@slop-lab/part-plugins/testing/index.js`                                                                                                                | Deterministic fake model fixtures; no real-provider compatibility claim                                          |

Mock providers are exported by `@slop-lab/part-node/testing/mock-provider/index.js`, with operator
tools at `@slop-lab/part-node/testing/mock-provider/tools.js` and a packaged `part-mock-provider`
CLI. The portable Chat Completions adapter is
`@slop-lab/part-plugins/providers/openai-compatible/index.js`. See [mock workflows](mock-provider.md)
for session ownership, exact fixture matching, transcript export and profile limits.
The separate `@slop-lab/part-plugins/providers/openai-responses/index.js` adapter supports stateless
Responses text/function calls over JSON/SSE and native reasoning replay. See
[Responses usage and limits](openai-responses.md).

The private `@slop-lab/car` workspace is an application composition rather than
an SDK dependency. Its sole declared package export is `openCar` from
`car/src/runtime.mjs`; the result exposes `agent`, `endpoint`, `hub`, `archive`,
startup `recovery`, and `close()`. Its authenticated version-1 inspector queries,
CLI options, local SWE tools, workflow forms, Router4u/toolset adapters, ownership
rules, and limits are documented in [the CAR profile](car.md). Other `car/src`
files are source-level helpers, not declared package exports.

`@slop-lab/part-plugins/acp/index.js` exports `createAcpAgent` for the ACP v1 agent profile:
initialization, per-session managed agents, text/embedded-text prompts, streaming
updates, permission-gated tools, cancellation and advertised session close.
`@slop-lab/part-node/acp/index.js` provides `startAcpStdio`; `@slop-lab/part-node/acp/mcp.js` provides the
authorized stdio MCP tools connector `connectAcpMcpServers`. Structural ports keep
the Node and portable packages independent. ACP connection shutdown owns and
cancels its sessions, unlike closing an ordinary runtime observation. See
[ACP usage, protocol bounds and unsupported capabilities](acp.md).

## Compatible model APIs

`createProviderModel` builds a `ConfiguredModel` for `createAgent`, CAR or a custom composition.
Set the protocol to match the endpoint. The same factory handles URL construction, auth,
request timeouts and headers across these protocols.

| Protocol    | Path under the base URL | Default credential header   |
| ----------- | ----------------------- | --------------------------- |
| `chat`      | `chat/completions`      | `Authorization: Bearer ...` |
| `responses` | `responses`             | `Authorization: Bearer ...` |
| `messages`  | `messages`              | `x-api-key`                 |

```js
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createProviderModel } from '@slop-lab/part-plugins/providers/index.js';

const model = createProviderModel({
  protocol: 'messages',
  baseURL: 'https://gateway.example/v1',
  apiKey: () => process.env.PART_API_KEY ?? '',
  model: 'fast',
  modelMap: { fast: 'provider-model-id' },
  headers: { 'x-project': 'support' },
  defaults: { max_tokens: 512 },
  timeoutMs: 90_000,
});
const agent = createAgent({ model });
```

Use `modelMap` to translate application model names to endpoint-specific IDs.
Without a mapping, the selected name is sent unchanged. An API key can be a string
or a callback that returns the current credential. Omit it for an endpoint without
authentication, or set `auth: 'bearer'` or `auth: 'x-api-key'` to match your gateway.
The base URL defaults to the official API for the selected protocol. Custom base URLs with a
path such as `/api/v1` retain that prefix. Requests reject HTTP redirects.

All three adapters support text and runtime function tools over JSON and SSE. Anthropic
Messages defaults to `anthropic-version: 2023-06-01` and `max_tokens: 1024`. Set
`anthropicVersion` or `defaults.max_tokens` as needed. The Responses adapter uses stateless
requests and supports replay of compatible reasoning items. A gateway that accepts Responses
but lacks encrypted reasoning can accept `defaults: { include: [] }` to request no optional
output fields. See [Responses usage and limits](openai-responses.md) and the
[Anthropic Messages API reference](https://platform.claude.com/docs/en/api/messages).

Build the workspace and run [the compatible provider example](../examples/compatible-provider.mjs)
with `PART_MODEL` set. Use `PART_BASE_URL` and `PART_API_KEY` for your gateway.

```sh
npm run build
PART_MODEL=model-id node examples/compatible-provider.mjs messages 'Say hello.'
```

## Sign in with ChatGPT

The server-side SDK is available from `@slop-lab/part-node/siwc/index.js`.

### Website identity

Create a client with `createChatGPTSignIn({ clientId, redirectURI, clientSecret })`. Supply
`clientSecret` for a confidential client provisioned for `client_secret_basic`. Call
`begin()` in your sign-in route, save its transaction against the initiating browser
session and redirect to the returned URL. In the callback, atomically consume that
transaction and call `complete(callbackURL, transaction)`. The SDK checks state and expiry,
exchanges the code with PKCE, and verifies the ID token against OpenAI's signing keys.
Link the verified `issuer`, `clientId` and `subject` to your local account and issue your own
application session. [OpenAI website integration](https://developers.openai.com/siwc/website).

[The HTTPS website example](../examples/siwc/website.mjs) demonstrates the routes,
one-time transaction, and application cookie with in-memory stores. Set the registered
`PART_SIWC_CLIENT_ID` and `PART_SIWC_CALLBACK_URL`, the file paths `PART_SIWC_TLS_CERT`
and `PART_SIWC_TLS_KEY`, and `PART_SIWC_CLIENT_SECRET` for a confidential client.
Run `just siwc-website` and open its HTTPS origin. For a deployment
with multiple instances, use a shared store that supports atomic, expiring transaction consumption.

### ChatGPT plan usage and Codex

For open-source apps, call `signInWithChatGPTLoopback` with your app's name, a persistent
host ID and a function that opens the authorization URL. For an existing account, pass its
saved registration and keep the callback path consistent. `createChatGPTPlanSignIn` exposes
`begin` and `complete` for apps that manage their own loopback listener. Check
`hasChatGPTPlanAccess` before starting inference. A verified sign-in without the required
grant can still be used for identity. Use `requestConsent: true` on a returning sign-in
when the user explicitly asks to enable plan usage. [OpenAI registration guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

```js
import { spawn } from 'node:child_process';
import {
  createChatGPTSession,
  hasChatGPTPlanAccess,
  signInWithChatGPTLoopback,
} from '@slop-lab/part-node/siwc/index.js';
import { createChatGPTModel } from '@slop-lab/part-plugins/providers/index.js';

const account = await signInWithChatGPTLoopback({
  appName: 'my_app',
  hostId,
  open: openSystemBrowser,
  registration: savedRegistration,
});
await saveAccount(account);

if (hasChatGPTPlanAccess(account)) {
  const session = createChatGPTSession({ credentials: account, save: saveAccount });
  const models = await session.listModels();
  // Use the selected model ID with createAgent or your runtime.
  const model = createChatGPTModel({ model: selectedModelId, accessToken: session.accessToken });

  // For a project using Codex app-server, pass credentials in the child environment.
  const { args, env } = await session.codexAppServer();
  const codex = spawn('codex', args, { env: { ...process.env, ...env }, stdio: 'pipe' });
}
```

`createChatGPTModel` uses the public OpenAI Responses endpoint with `stream: true` and
`store: false`. It sends system context as developer messages and declares runtime function
tools through `additional_tools`. The route accepts a subset of Responses options.
Runtime failures expose the HTTP status, request ID and structured provider error code
in `error.details` when available.
[ChatGPT plan route limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

`listModels()` returns the signed-in account's displayable model IDs.
If you use app-server, initialize the child with your stable app identity in
`clientInfo`. On renewal, restart it with a new `codexAppServer()` configuration and
resume the thread by ID. [OpenAI inference guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[OpenAI app-server guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

Keep account registrations and credentials in protected server-side or local storage.
Share a session instance per account and serialize refreshes across processes that share
credentials. The session refreshes near expiration and calls `save` with the rotated
credential record before using it. On sign-out, stop the session, revoke the latest
credentials with `revokeChatGPTCredentials`, and clear the local tokens while retaining
the registration identity and host ID for reauthorization.
[OpenAI accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

[The CLI example](../examples/siwc/plan.mjs) persists a host ID and the selected account
in a private local directory, lists models, and asks a selected model to generate text.

```sh
just siwc-cli signin
just siwc-cli models
PART_SIWC_MODEL=model-id just siwc-cli ask 'Say hello.'
```

### Use the SDK with multiple users

Create a shared account manager and scope each call to an authenticated application
user. The ID comes from your server-side application session. Save the verified
registration from that same user's OAuth transaction with `connect`.

```js
import {
  createChatGPTAccounts,
  createMemoryChatGPTAccountStore,
} from '@slop-lab/part-node/siwc/index.js';
import { createChatGPTModel } from '@slop-lab/part-plugins/providers/index.js';

const accounts = createChatGPTAccounts({
  store: createSqliteChatGPTAccountStore('/absolute/path/to/private/siwc-accounts'),
});
const account = accounts.forUser(authenticatedUser.id);
await account.connect(verifiedRegistration);
const models = await account.listModels();
const model = createChatGPTModel({ model: selectedModelId, accessToken: account.accessToken });
```

Use the same authenticated user ID and storage directory after a restart to
reuse the connection. The SQLite store keeps one database per user and serializes
refreshes across processes sharing a local filesystem. On Unix the directory
must be owner-only. Use `createMemoryChatGPTAccountStore()` for ephemeral sessions.
For multiple hosts or an existing database, implement `ChatGPTAccountStore.withAccount`
with per-user serialization and atomic updates of the complete credential record. Keep OAuth transactions single-use and
bound to the same user session before exchanging their codes. Account managers
and stores should live on the server. An existing runtime can call `accessToken`,
`listModels`, `codexAppServer`, or `disconnect` for that user.

The [full playground](playground.md#connect-a-chatgpt-plan) demonstrates this with
independent browser sessions and an optional ChatGPT provider alongside API-key providers.

### Browser PoC with a pasted callback

Start [the web example](../examples/siwc/plan-web.mjs) from the repository root.

```sh
just siwc
```

The recipe installs dependencies when needed and builds the workspace. With npm,
run `npm ci` the first time, then use `npm run example:siwc`.
The npm equivalents for the other examples are `npm run example:siwc:cli -- <command>`
and `npm run example:siwc:website`.

Open `http://127.0.0.1:4174`, select **Continue with ChatGPT**, and open the
authorization link in a new tab. This example uses open-source dynamic registration.
If the callback tab shows a connection error, copy its full
`http://127.0.0.1:.../auth/callback?...` URL and submit it on the PoC page.
If the callback reaches the local listener, return to the PoC tab and check its status.
After signing in with plan access, use the page to load models and try a prompt.

When the process runs on a remote machine, forward the UI port to your browser machine
with `ssh -L 4174:127.0.0.1:4174 user@host`, then use the paste field for the callback.
The example listens on loopback. Its signed browser session cookie and private SQLite
account store preserve a connection across server restarts. Set `PART_SIWC_DIRECTORY`
to change the local storage location.
The SDK's `open(url, submitCallback)` hook lets other apps submit a pasted URL for
the same one-time transaction used by the HTTP listener.

## Extension contracts

`lowerersPoint` is a context-owned registry and `transformsPoint` is a context-owned
pipeline. A consumer component may contribute a new type or ordered transform
without replacing the compiler. Contributions use structural point identity and
explicit IDs; duplicate keys and ordering cycles fail before opening a scope.
Whole-service replacement remains available through `contextPoint`, `modelPoint`,
and `toolsPoint`. `handlersPoint` and `enginesPoint` belong to optional workflow modules.

`installTool`, `installDriver`, `installAction`, `installQuery`, and
`installStepHandler` create local validated bindings. Their opaque handles cannot
be manufactured by serializing a similarly shaped object. Schemas validate actual
inputs and outputs. Provider tool advertisement JSON Schema is separately supplied
through `toolSchemas`; there is no implicit TypeScript-to-JSON-Schema conversion.

`createPlanner({ schemas, surface })` can validate component configuration schemas
and target surfaces. Factories currently depend on services in the same scope;
parent-scope lookup and ownership transfer are unsupported. Cleanup failures expose
released/unresolved refs and errors. Scope registries expose read-only views.

## Execution guarantees

Observation close/disconnect/unmount does not cancel execution. Cancellation
requests propagate to attached work; confirmation follows termination. Unacknowledged
work becomes abandoned with unknown effects and unresolved refs. Late results do
not revive terminal runs. Operation signals end when their owning execution ends. Active snapshots report
unknown effects conservatively until a terminal outcome supplies evidence.

`managedAttempt` waits for prepare, executes at most once, validates its local
single-use permit, and awaits settlement. A failed settlement preserves applied or
unknown effects. No layer automatically retries writes. Shared invocation, dispatch,
attempt, concurrency, child-run, known-token and deadline budgets are supported.
Known token accounting cannot prevent already-incurred provider usage. Estimated model cost budgets use the explicit pricing profile described below.
Operation ownership transfer requires an external owner; resource transfer uses
`ResourceManager`.

The node script host runs a snapshot file using a configured interpreter. Scripts
must be standalone; relative imports from the original script directory are not
preserved. Configured environment profiles are copied; the default child environment
is empty. POSIX execution owns a process group; Windows execution owns a Job Object
that includes detached descendants. The Windows supervisor is compiled and cached
using the .NET Framework C# compiler included with Windows. Both hosts terminate
descendants on normal exit, cancellation and timeout. POSIX group escape and
arbitrary network calls are not sandboxed. Unconfirmed termination remains
unknown/abandoned.
Low-level script completion reports exit status; workflow script steps additionally
require exit code zero and complete capture. Logs are not automatically captured as
results. `stdout-json`, declared JSON file capture and a versioned result channel
are supported. Channel v1 uses child fd 3 with newline-delimited UTF-8 JSON frames:
`{protocolVersion:1, channelId, kind:"progress"|"result", payload}`. Exactly one
complete result is required; stdout/stderr are separate diagnostic streams.
Source/package and workspace resolution use explicit host callbacks; returned
source bytes are copied and digest checked. No callback is inferred from a wire path. Optional `@slop-lab/part-plugins/scripts/bridge/index.js`,
`@slop-lab/part-plugins/scripts/bridge/services.js`, and `@slop-lab/part-node/scripts/bridge.js` provide explicit grant
issuance, authenticated loopback RPC and host-installed model/run/result/wait methods.
Attach the listener to `createNodeScripts({ bridge })`; a public grant ID cannot
authenticate a request. Grants inherit owner cancellation/deadlines and combine local
limits with the parent budget. Stable request IDs deduplicate within the grant lifetime.
For the Node script host, the grant audience must equal the script relative path.
The credential and audience travel separately from the public ID. Revocation cancels managed children; it does not sandbox arbitrary script I/O.

## Wire and UI

Embedded action v1 inputs are a string for `part.run/start` and `null` plus a run
target for `part.run/cancel`. These concrete alpha inputs differ from the broader
proposed `ControlCatalog` DTOs. Commands never carry trusted invocation contexts.
The HTTP host requires a context/authentication callback; no client actor field is
promoted to authority. Host bind and transport origin allowlists are explicit.

Memory command dedupe is principal plus command/idempotency key, for endpoint
lifetime, with a capacity of 1,000 entries. Capacity exhaustion rejects admission
rather than evicting a key and silently re-running a write. Same-key content changes
are conflicts. Lost command responses remain delivery-unknown; aborting an HTTP
request is independent of cancelling the run.

Watch setup registers observation before capturing its watermark. Slow observers
receive a gap and the controller reconnects to a snapshot. UTF-16 generation/offset
mismatches do not concatenate arbitrary text. Use
`hub.upsert(item, { clearStreamingParts: true })` to replace an item's streamed
preview with an authoritative message or to start a fresh model call. Item removal
also clears that item's parts. Audience reset clears all cached items and streaming
parts. The reference watch hub owns one already-authorized audience;
applications must maintain separate hubs or re-project/reset when rights change.

DOM Chat batches stream updates per animation frame and reuses completed Markdown
blocks. It also supports safe Markdown/code, custom cards, theme tokens, pagination,
IME/draft safety and owner cancellation. `command` is
optional for the built-in string start action. `ChatComponents` gives actual DOM
Message/Fallback/ToolDetails/Composer signatures. Ordered slots include
`composer.actions`, `message.actions` and `artifact.preview`; Inspector adds
`inspector.tabs`. Equal-priority renderer collisions and ordering cycles fail.
Artifact previews load only on explicit interaction through an authorized reader;
bytes never execute as HTML/SVG. Markdown is a documented subset (paragraphs,
headings, lists, quotes, fences, inline code/emphasis and absolute safe links),
not full CommonMark compatibility. Browser visual audits and production-scale
history performance require separate measurements. Headless APIs remain independent.

## Optional-module limits

- `createRunService({ history })` accepts an explicit `RunHistoryAttachment`.
  `createChatHistoryAttachment(history)` projects earlier immutable messages into
  the next request and commits input/terminal records against the selected head.
  Concurrent branch writers and stale heads conflict. Generic drivers supply their
  own input/record projection. Runs enforce resolved composition handles and principal
  ownership; live driver actions use `describeActions`/`receive` when advertised.
  No arbitrary driver stack, durable wait or workflow step resume is claimed.
- SQLite stores one serialized materialization/journal snapshot per store ID in an
  atomic transaction. It is a correctness reference for bounded local data, not a
  backend optimized for very large histories or distributed writers.
- Results support inline JSON, digest-pinned artifact/captured references, and explicit
  processor chains with input/output schemas and matching validation evidence.
  `createResults(types, options)` accepts artifact/capture resolvers, validation
  profiles and a trusted producer authorization callback for multi-owner hosts.
  Processors run in attached operations with a configurable timeout (30 seconds by
  default); late results cannot revive failed submissions. Concurrent identical submissions share processing; changed content conflicts.
  `@slop-lab/part/artifacts/index.js` provides bounded memory storage; `@slop-lab/part-node/artifacts.js` explicitly
  opens a durable directory backend. Finalization publishes immutable bytes only
  after storage succeeds. Reads authorize the principal and validate digest/range.
  `@slop-lab/part/host/runtime.js` supplies bounded priority admission, pending replacement,
  request dedupe and drain/cancel shutdown. `@slop-lab/part/host/resources.js` owns registration,
  explicit transfer and cleanup with unresolved-resource evidence. Both are optional.
- Ollama supports text, thinking, complete object function arguments and token usage.
  Media, foreign native content, hosted tools and continuation tokens are rejected.
  Real-provider smoke and broader compatibility remain deferred.
- SKILL.md supports scalar `name`, `description`, and `license` frontmatter. Other
  fields or YAML constructs fail explicitly. Activation returns instructions and
  references only; it does not install hooks, tools, scripts or workflow engines.
- Reference workflow engines use one configured service composition named `default`;
  unknown execution profile IDs fail prepare. Code definitions are trusted explicitly registered functions; source hashes cover
  the function text and schema refs, not arbitrary mutable closure state. Code replay
  is `none`. Pipeline supports lexical branch, bounded repeat (up to 10,000 iterations),
  bounded parallel (up to 64 workers), step timeouts and installed handler capabilities.
  Block depth is bounded at 32 and total steps at 10,000. Parallel `collect` joins all
  required branches and fails if any fails; `cancel-and-join` cancels siblings before
  returning failure. Results preserve branch order. Agent steps may bind digest-pinned
  skill activations through an installed host input adapter; activation is released
  after the step. No automatic role elevation or script execution is inferred.
- Reference workflow submission dedupe is memory-only. Nested workflows share parent
  reservations. Durable code/pipeline recovery is unsupported. `@slop-lab/part-plugins/workflows/external.js`
  adapts a native scheduling/state owner with submit, attach, reconciliation, native
  actions and observation. Uncertain submission is never automatically repeated.
  The independent native fixture proves these boundaries, not product compatibility.
- `@slop-lab/part-plugins/workflows/endpoint.js` resolves registered definition/digest/profile/composition
  references locally; wire never carries Prepared tokens or executable modules.
  It projects authorized status, result, waits and actions without raw native state.
  `@slop-lab/part-browser/workflow.js` provides safe default cards and JSON action/approval forms,
  independent of custom renderers. Unknown delivery preserves the command ID.
  Closing observation does not cancel the execution; endpoint shutdown does.

## Change procedure

Pin the exact tarball and lockfile. Before changing a used contract, update the
changelog, record migration guidance, and run runtime plus packed consumer tests.
Do not create a second dispatcher/history/workflow owner in a consumer to bypass a
runtime defect. Replace public parts or propose a generic boundary change instead.

## Explicit cost and ownership profiles

`estimatedCostCeiling` accepts a nonnegative decimal with at most six fractional
places and one ISO-style currency code. A managed gateway requires a configured
`CostEstimator`; it reserves the declared estimate before sending. Missing pricing,
currency changes and exhaustion fail before transport. This controls estimates;
it does not cap actual provider billing or arbitrary script/API spending.
Child scopes combine reservations with the upstream budget. `operationOwnerKey`
keeps attached calls from separately configured services under the parent supervisor.

The Node script host's `executor()` plugs into the tool dispatcher. It checks the
matching single-use permit and uses one outer prepare/settle/executor reservation;
it does not reserve a second actual attempt for the nested script operation.
Direct workflow `Scripts.execute` retains its own boundary. Tool effect classification
must match the script request. External executors can also be supplied to the agent.

`createNamespaceMigrations` receives explicit addresses and a target schema. It
publishes migrated records and the ready ledger atomically, records failures and
refuses new-schema reads until publication. An interrupted running ledger requires
explicit owner reconciliation. `createCheckpointStore` stores engine-owned CAS
checkpoints and cannot serialize an async stack or schedule a continuation.

`createAgentStepBinding` attaches identical stable-key requests within its lifetime;
changed input/config conflicts. It explicitly advertises no inner-effect checkpoint.
Recipe retry only repeats successful, read-only agent invocations whose validation
failed; agent failures, writes and uncertain effects are never automatically retried.

Trace collection is opt-in and host instrumented. Metadata mode drops bodies and
credentials; redacted mode requires an installed redactor. `none` stores no trace
frames. Manifest/trace access is principal-owned, retention is bounded and deletion
is explicit. No external telemetry destination is activated on import.
