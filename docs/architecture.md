# Architecture decisions

Status: experimental. Project name: part (progressive agent runtime).
The local 0.2 design is the requirements baseline; its former `car` prefix is
renamed to `part`. Reference declarations are design contracts, not a claim that
all optional modules are implemented.

1. TypeScript, ESM, Node >=22.18 for the reference server. Core uses portable
   JavaScript APIs and has no runtime dependencies. Browser entrypoints must not
   import Node executors, storage, or credentials. npm provides reproducible installs.
2. Runtime schemas validate unknown values. Strict JSON codecs reject lossy values,
   cycles, non-finite numbers, accessors, and non-plain objects. Local capabilities
   and services are never encoded as wire requests.
3. Composition is explicit, deterministic, and immutable after resolution. Required
   contract versions match exactly. Plugins are trusted code, not a sandbox.
4. Operations own execution independently of subscribers. Cancellation requests
   are distinct from acknowledgement; uncooperative work remains unresolved.
   Effects are never inferred to be rolled back by cancellation or persistence failure.
5. Memory is the default. Optional local storage will use SQLite transactions for
   state plus journal. No database or network resource opens on import.
6. Initial remote transport target is HTTP plus SSE. Provider encoding, authentication,
   and transport remain independently replaceable. No automatic retries for writes.
7. UI is an optional DOM/headless layer. CSS and renderers do not affect model input.
8. Performance baseline: zero active resources and zero runtime dependencies on core
   import. Measured latency and memory are reported per fixture, not universal budgets.

Public APIs remain experimental. G-BASE passes for the selected reference profile;
consumers must pin exact versions.
Breaking changes require a changelog, migration guidance, and consumer fixture runs.

The repository is an npm workspace with four packages:

- `packages/core` owns environment-independent contracts, composition, runtime,
  model/tool ports, context, clients, generic storage and script bridge ports.
- `packages/plugins` owns portable agent presets/drivers, providers, hooks/skills,
  script bridge policies, workflow engines and deterministic fake models.
- `packages/node` owns cross-platform process execution, authenticated loopback transport,
  HTTP hosting, SQLite, immutable file artifacts and directory snapshots.
- `packages/browser` owns DOM/headless presentation and styles.

Only core has no runtime package dependencies. Plugins, Node and browser each
have one exact-version dependency on core. Core cannot reference another package,
and environment packages do not reference each other or the portable plugin bundle.
Cross-package imports use declared public exports, including type-only ports;
relative paths never cross a package boundary. Each package owns its sources,
TypeScript project, build output, explicit exports, README and tarball. The repository
root is private development tooling and does not aggregate the SDK. There are no
mandatory plugin bundles in a core-only or browser-only installation.

Within packages, modules are grouped by responsibility. Pipeline compilation,
execution, handlers and value resolution are separate. The memory workflow engine
separates submission/lifecycle, managed calls, output validation, identity and snapshots.
Core design reference namespaces remain separate type-only modules.

Composition separates planning, opaque handle storage and scope ownership. The client
separates codecs, watch state, local transport and controller state. The Node script
host separates admission/attempt ownership, immutable source selection and process I/O.

Imports use their original descriptive names. Public package paths follow the
domain hierarchy, such as `@slop-lab/part-plugins/workflows/code`, `@slop-lab/part-plugins/providers/ollama` and
`@slop-lab/part-browser/dom`. Flat compatibility paths and the duplicate core entrypoint are removed.
Internal modules import their actual dependencies instead of their own public barrels.
Shared budget/effect logic belongs to runtime, so script and workflow engines do not
depend on model gateways or agent drivers. Internal helper paths are not public exports.
Builds remove stale output before compiling and copy the public stylesheet explicitly.
`npm run check` rejects unused code, import aliases, runtime cycles, reversed layer
dependencies, Node imports from portable entrypoints and exports that disagree with
the source domains. Packed-consumer checks load every JavaScript entrypoint, compile
every public declaration entrypoint and verify the stylesheet is present.
Portable declarations compile without ambient Node types; the HTTP host's
`IncomingMessage` callback is additionally checked with explicit Node typings.

The initial provider adapter targets the documented Ollama `/api/chat` NDJSON
subset: text, thinking, function calls, and usage. Media and foreign native content
require explicit projection. See https://docs.ollama.com/api/chat . Live
Ollama smoke remains unverified; fake fixtures establish only that adapter's
implemented protocol subset. The separate OpenAI-compatible Chat Completions adapter
has an opt-in [provider smoke test](provider-smoke.md).
The separate portable [Responses adapter](openai-responses.md) uses explicit stateless
input, native reasoning replay and completed-response validation.

The project runs `--test-isolation=none` so individual registered tests execute
and contribute to the run summary. The reporter displays failures and the summary.
Test fixtures own and clean up all resources.

The SQLite reference adapter uses `node:sqlite` (`DatabaseSync`) and explicit
transactions with FULL synchronous mode. API source: https://nodejs.org/api/sqlite.html .
It stores one state/journal snapshot per store ID; this is a correctness reference,
not a backend optimized for large histories. Storage import opens no database.
Store access is trusted in-process; history and embedded endpoint enforce their
own principal ownership. No database grants or cross-service atomicity are claimed.

The optional DOM binding concretizes the framework-neutral UI contracts using
HTMLElement. It supports explicit component signatures, per-type renderers, ordered slots,
safe Markdown/code, artifact previews, Inspector/Workbench, pagination,
keyboard/IME handling and CSS tokens. UI extensions use public client contracts;
raw HTML and executable artifact documents are not interpreted.

The skill reader follows an explicitly limited subset of the Agent Skills
specification: https://agentskills.io/specification . It rejects unsupported
frontmatter rather than ignoring required behavior. This loader's package policy
rejects all symlinks. No package discovery imports executable modules.

Reference workflows are optional trusted async code and a separate dependency-
ordered pipeline interpreter. They share execution services and observation,
not a mandatory kernel DAG. Both advertise runner-path-only effects, memory
submission dedupe, and no durable checkpoints. Their state is owned by the engine.
There is no automatic workflow retry, continuation serialization or native adapter
compatibility claim.

The authenticated script bridge uses an explicitly started loopback RPC listener.
A grant ID is public metadata; a separate bearer credential plus audience is required.
The host fixes actor context, permitted methods/profiles, expiry, limits and cancellation.
Node execution binds the audience to the script source path. This is an IPC authority
boundary, not an OS sandbox for trusted script code.

Artifacts finalize immutable bytes through bounded memory or an explicitly opened
file backend. The durable file backend commits one fsynced atomic metadata/byte
record and fsyncs its directory. State migration uses CAS and atomically publishes
new schema data with the ready ledger. Checkpoint persistence does not imply resume.

Reference pipelines now support bounded lexical branch/repeat/parallel and per-step
timeouts. Recipe retry is a separate read-only validation policy; native adapters
retain their scheduler, state, actions and reconciliation semantics. No universal DAG
or application workflow editor is part of the kernel. All managed nested operations
inherit their actual parent supervisor, even when a module has a different default.
