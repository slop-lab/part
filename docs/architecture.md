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
