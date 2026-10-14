# Changelog

## 0.1.0-alpha.2 (unreleased)

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
