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

`@slop-lab/part-plugins/acp/index.js` exports `createAcpAgent` for the ACP v1 agent profile:
initialization, per-session managed agents, text/embedded-text prompts, streaming
updates, permission-gated tools, cancellation and advertised session close.
`@slop-lab/part-node/acp/index.js` provides `startAcpStdio`; `@slop-lab/part-node/acp/mcp.js` provides the
authorized stdio MCP tools connector `connectAcpMcpServers`. Structural ports keep
the Node and portable packages independent. ACP connection shutdown owns and
cancels its sessions, unlike closing an ordinary runtime observation. See
[ACP usage, protocol bounds and unsupported capabilities](acp.md).

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
mismatches do not concatenate arbitrary text. Audience reset clears cached items
and streaming parts. The reference watch hub owns one already-authorized audience;
applications must maintain separate hubs or re-project/reset when rights change.

DOM Chat supports safe Markdown/code, cached completed blocks, custom cards,
theme tokens, pagination, IME/draft safety and owner cancellation. `command` is
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
