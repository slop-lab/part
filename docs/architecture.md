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

Public APIs are experimental until G-BASE passes. Consumers must pin exact versions.
Breaking changes require a changelog, migration guidance, and consumer fixture runs.

The initial provider adapter targets the documented Ollama `/api/chat` NDJSON
subset: text, thinking, function calls, and usage. Media and foreign native content
require explicit projection. See https://docs.ollama.com/api/chat . Real provider
smoke testing is deferred at the user's request; fake fixtures establish only the
implemented protocol subset.

This environment's Node 26 test subprocess runner reports file-level tests only.
The project runs `--test-isolation=none` so individual registered tests execute and
report counts explicitly. Test fixtures own and clean up all resources.

The SQLite reference adapter uses `node:sqlite` (`DatabaseSync`) and explicit
transactions with FULL synchronous mode. API source: https://nodejs.org/api/sqlite.html .
It stores one state/journal snapshot per store ID; this is a correctness reference,
not a backend optimized for large histories. Storage import opens no database.
Store access is trusted in-process; history and embedded endpoint enforce their
own principal ownership. No database grants or cross-service atomicity are claimed.

The optional DOM binding concretizes the framework-neutral UI contracts using
HTMLElement. It supports the composer.actions slot, per-type renderers, safe plain
text fallbacks, pagination, keyboard/IME handling and CSS tokens. Markdown, artifact
viewers, custom component substitution, and additional slots remain later UI work.

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
