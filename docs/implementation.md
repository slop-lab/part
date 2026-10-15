# Implementation coverage

The runtime is named **part (progressive agent runtime)**. The ignored `.local/`
source specification retains its original `car` name; implementation identifiers,
package exports and examples use `@part/core`.

This release implements the specification's initial local profiles through S3,
including the actual code and pipeline plugins required by section 16.1. The
source document deliberately distinguishes initial requirements from S4 and
adapter-specific future compatibility. This file records that boundary rather
than treating every proposed declaration as a shipped guarantee.

| Specification area         | Implemented local profile                                                                                                                                                                  | Evidence                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| L0 composition             | Exact schema/capability versions, structural points, deterministic order, explicit replacement, scopes and rollback                                                                        | Foundation/extension tests; packed contract consumer                              |
| L1 execution               | Independent completion, parent-owned services, attached cancel/join, shared budgets/deadlines, awaited single-use boundaries                                                               | Foundation tests, cross-supervisor ownership and cleanup fixtures                 |
| Driver/model/tools         | Own basic loop, post-stop validation, pinned inputs/config, provider/auth/transport separation, tool middleware and external executor SPI                                                  | Agent/extension/HTTP tests; non-coding and SWE consumers                          |
| History/context/projection | Immutable CAS branches, explicit run attachment, source versions/maps, extensible lowering, authorized safe public views                                                                   | Storage/extension/history attachment tests                                        |
| Results/artifacts          | Explicit JSON capture, pinned artifact/capture bytes, schemas/processors/timeouts, immutable memory and durable file artifacts                                                             | Artifact/bridge/optional-contract tests                                           |
| Skills/packages/hooks      | Explicit digest-pinned discovery/activation, host-controlled lowering, once/scope/recursion/matcher/failure policies                                                                       | Skills/hooks and pipeline skill fixtures                                          |
| Scripts/bridge             | POSIX snapshot execution, argv/stdin, stdout/file/channel capture, package/workspace callbacks, shared tool attempts, authenticated audience-bound RPC                                     | Real subprocess/RPC fixtures, grant/budget/expiry/cancel checks                   |
| Workflow forms             | Trusted code, lexical bounded pipeline, read-only recipe validation retry, native submit/attach/reconcile, stable child-agent attachment                                                   | Workflow/client/conformance tests and packed workflow consumer                    |
| Host/storage               | Priority queue, pending replacement, dedupe, drain/cancel, resource transfer/cleanup, SQLite journal/state, intent recovery, namespace migration, checkpoint storage port                  | Host/external/storage/optional-contract tests                                     |
| Client/UI                  | Codec loopback and HTTP/SSE, normalized snapshots/deltas, IME/draft/scroll, safe Markdown, concrete DOM components, ordered slots, generic workflow actions, Inspector/Workbench/artifacts | Client/UI/workflow DOM tests, standalone preview and long-history cache benchmark |
| Observability/cost         | Explicit manifests/redaction/retention and decimal model estimates reserved before transport                                                                                               | Optional-contract tests; no core import resource activation                       |

Local provider test support includes an agent-operated loopback Chat Completions
mock, exact fixed fixtures, operator tools/CLI and transcript-to-fixture conversion.
The portable OpenAI-compatible adapter is verified against this local profile,
including a real agent/function-tool loop. See [mock workflows](mock-provider.md).
The separate live R4U smoke also passed JSON/SSE text and a real function-tool loop;
see [provider evidence](provider-smoke.md).
The separate [Responses adapter](openai-responses.md) also passes live R4U JSON/SSE
and function-tool smoke; fixed fixtures verify native reasoning replay and prevent
tool execution on incomplete streams.

The [browser playground](playground.md) composes the public runtime/client/UI packages
into six executable scenarios, with Scripted and opt-in server-side R4U providers.
It uses bounded memory history and approval middleware; it is not a workflow engine
or a durable product host.

## Dependent-project readiness

The optional [ACP agent plugin](acp.md) exposes configured part agents to editor
clients over the separate Node stdio adapter. Local official-SDK interoperability,
permission/cancellation races, bounded transport, session-owned MCP tools and live
R4U text smoke are verified. This does not certify a specific editor GUI or every
ACP/MCP capability. Calling external ACP agents remains separate scope.

Dependent projects can start local development against selected alpha.2 workspace
packages and a lockfile, using fake endpoints or their own configured provider.
`npm run pack:local` creates four independent tarballs. Seven isolated consumers
cover core-only, non-coding, SWE, public TypeScript extensions, workflow, Node-only
adapters and browser-only UI. They validate every public code/type/CSS entrypoint
without installing unrelated packages. There is no reverse dependency on SWE.

The actual-provider/custom-endpoint smoke passed with the supplied R4U configuration
and `gpt-6-luna`, after Chat Completions was enabled and nullable tool-call decoding
was corrected. G-BASE passes for this selected reference profile. See
[reproduction and evidence](provider-smoke.md). Hosted CI was not run. G-WORKFLOW has local reference-profile evidence; real external
product compatibility must be certified per adapter/version.

## Separate later scope

The specification marks these as later or adapter-specific work, not guarantees of
this local reference profile:

- Arbitrary async stack replay, durable memory-code continuation, durable wait/step
  scheduling and automatic recovery of native engine stacks. Checkpoint persistence
  and external reconciliation are available without claiming those capabilities.
- LangGraph/Lobster/n8n/Goose product-format compatibility, isolated containers/WASM,
  distributed admission and cross-service transactions. A native port owns its
  scheduler and must expose its actual guarantees.
- Graph editors, collaboration products, full file editors/PTY/diff/worktree behavior
  and domain-specific business schemas. Those remain application/plugin-owned.
- Full YAML/CommonMark/provider media dialects, framework-specific React/Vue bindings,
  broad browser/device audits and production-scale persistence/history tuning.

Unknown required behavior fails explicitly. See [the supported API profiles](api.md)
for concrete limits and [gate evidence](gates.md) for the executed checks. Test
families identify covered assertions; they do not certify every possible race or
variation in the specification's conformance catalog.
