# Changelog

## 0.1.0-alpha.2 (unreleased)

- Enforce strict JS/MJS checks, checked indexed access, unused-code checks and full
  dependency declaration checks. Type runtime state, callbacks, protocol fixtures and
  test doubles; validate metadata and unknown inputs at their boundaries. Add compile-only
  regressions for the JS contracts and keep ACP byte-stream adaptation type safe.

- Publish `dist` as each package root. Generate only its distribution metadata with
  `.` for an existing root index and `./*` for all built files; keep workspace
  metadata unchanged during builds. Replace source export annotations and individual
  maps with explicit `.js` subpaths, including directory `index.js` imports.

- Add an ACP v1 agent plugin, separate Node stdio transport and authorized stdio
  MCP tool connector. Support text streaming, session ownership, permission-gated
  dispatch, cancellation and bounded cleanup; verify official SDK interoperability.
- Add runnable ACP agent/client examples with scripted and optional R4U providers,
  Zed configuration and isolated package-consumer coverage.

- Replace the static chat preview with a six-scenario browser playground using real
  managed agents, tools, approval waits, artifacts and HTTP/SSE. Add server-only
  opt-in R4U providers, request/event inspection, memory sessions and responsive themes.
- Add a documented Chromium interaction suite and playground ownership regressions.

- Add the portable `@slop-lab/part-plugins/providers/openai-responses/index.js` adapter for stateless
  JSON/SSE text, runtime function calls and native reasoning replay. Validate final
  snapshots before tool execution, with exact fixtures and live R4U smoke.
- Add `npm run smoke:responses` using the shared bounded provider smoke flow.

- Accept nullable tool calls in JSON/SSE Chat Completions responses while rejecting
  malformed non-null values. Verify live R4U text and function-tool flows with
  `gpt-6-luna`, closing G-BASE for the selected reference profile.

- Add an opt-in R4U smoke command with capability discovery and bounded JSON/SSE/tool
  checks. Record protocol mismatches before inference.
- Omit streaming-only usage options from non-streaming Chat Completions requests
  and exclude local environment credentials from Git.

- Add loopback OpenAI-compatible interactive/fixed mock providers, project-bound
  operator tools and the `part-mock-provider` CLI. Export successful interactive
  transcripts as exact ordered fixtures for noninteractive replay.
- Add a portable Chat Completions text/function-tool adapter, agent tool-loop
  examples and fixed/interactive golden transcripts.

- Split the SDK into `@slop-lab/part`, `@slop-lab/part-plugins`, `@slop-lab/part-node` and `@slop-lab/part-browser`.
  The private workspace root is not an aggregate package. All three optional packages
  depend only on the matching core version; each has independent output and packaging.
- Verify seven isolated consumers and all public entrypoints, including core-only,
  Node-only and browser-only installs without unrelated packages.

- Replace abbreviated import aliases with descriptive names and group source files
  by responsibility. Public paths follow their domains, including `@slop-lab/part-plugins/workflows/code.js`,
  `@slop-lab/part-node/scripts/index.js` and `@slop-lab/part-browser/dom.js`; remove flat compatibility paths and `part/core`.
- Move shared budget/effect helpers into runtime and use direct internal dependencies.
- Separate workflow lifecycle, managed calls, output validation and state; split script
  admission/source/process handling, composition planning/scopes and client codec/watch/controller.
- Check architecture boundaries and unused code locally and in CI; validate every
  public entrypoint from an isolated packed consumer.
- Split runtime primitives, pipeline compilation/execution and reference namespaces
  into separate modules; clean build output before compilation.
- Complete local workflow integration: nested pipelines, authenticated script bridge,
  generic endpoint/UI, native submission reconciliation and stable agent-step attachment.
- Add artifact stores, result processors/timeouts, recipe validation retry and pinned skills.
- Add admission/resource ownership, run history, driver actions, checkpoint storage,
  namespace migration, decimal estimated-cost ceilings and optional trace policy.
- Add safe Markdown, concrete DOM components, ordered slots and Inspector/Workbench.
- Keep separately configured nested services under the actual parent supervisor and
  share one prepared executor attempt between script tools and the script host.
- Enforce principal ownership and resolved run composition handles.
- Verify local fixtures; actual-provider smoke remains explicitly deferred.

Migration: existing basic/embedded start inputs remain strings. Script bridge grants
must use the script relative path as audience and send the new audience header.
Direct `createRunService` callers must pass a planner-resolved composition handle.
DOM component overrides now have concrete exported signatures. Durable checkpoint
storage does not enable code/pipeline replay. Pin this version and rerun consumers.
Update imports to the domain paths listed in `docs/api.md`; there are no compatibility
aliases. `reserve`, `budgetKey` and `combineEffects` belong to `@slop-lab/part/runtime/index.js`.
The public stylesheet is `@slop-lab/part-browser/styles.css`. Use `npm run pack:local`
and install core plus only the required optional package tarballs.

## 0.1.0-alpha.1 (local baseline)

- Establish part naming, TypeScript package boundaries, and design reference.
- All APIs remain experimental; neither integration gate is certified.
- Implement deterministic composition, scoped initialization and rollback.
- Add independent operations, cancellation acknowledgement, bounded observation,
  shared budgets, awaited prepare/settle boundaries, and memory suspensions.
- Add validated function tools and allow/deny/substitute/rewrite/redirect/suspend policies.
- Add context planning/lowering/transforms/source maps and an Ollama NDJSON adapter.
- Add an embedded agent, basic loop, post-stop validating driver, and non-coding fixture.
- Add memory and optional SQLite state/journal storage, immutable history, and
  explicit recovery of incomplete execution intents.
- Add schema-validated owner actions/queries, memory command dedupe, codec loopback,
  snapshot/event client state, headless composer, and themed DOM Chat.
- Add authenticated host-context HTTP commands/queries and SSE observation.
- Validate a custom provider endpoint with a local HTTP fake.
- Add isolated packed non-coding, SWE, and TypeScript extension consumers.
- Add a standalone Chat preview, source boundary experiment, core import measurements,
  deterministic composition hashing, and CI configuration.
- Add optional pinned directory packages, restricted skill activation, script hook
  enforcement, explicit JSON results, standalone POSIX script execution, and actual
  code/pipeline workflow engines with memory waits and submission dedupe.
- Expose context-owned lowerer and transform registries for consumer extensions.
- Preserve unresolved resource cleanup evidence and unconfirmed process groups;
  guard input mutation, long deadline overflow, and native workflow revisions.
- Add authorized public projection and reject unknown wire envelope fields.
- Add consistent formatting and documented experimental support/change procedures.

No migration from a previous runtime release is required: this is the first local
integration alpha. The `car` prefix in the local design is renamed to `part`.
Actual provider smoke is deferred. G-BASE and G-WORKFLOW are not formally certified.
