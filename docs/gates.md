# Integration gate evidence

Candidate: `@slop-lab/part`, `@slop-lab/part-plugins`, `@slop-lab/part-node` and `@slop-lab/part-browser` at `0.1.0-alpha.2`.

**Dependent projects can start against the selected pinned package tarballs.**
G-BASE passes for the selected reference profile, including live R4U Chat Completions
and Responses JSON/SSE/function-tool smoke with `gpt-6-luna`. See
[provider smoke](provider-smoke.md) and [Responses evidence](responses-smoke.evidence.json).
G-WORKFLOW's local reference profile has execution evidence for every gate area.
This does not certify third-party product compatibility or durable continuation.
See [implementation coverage](implementation.md) and [support limits](api.md).

## G-BASE

| Gate | Actual evidence                                                                                                                             | Status                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| G01  | ADRs, strict codecs, seven isolated packed consumers, zero runtime dependencies                                                             | Verified local profile                                                                      |
| G02  | Input → fake model → function tool → result, cold import resources/heap/time                                                                | Verified                                                                                    |
| G03  | Text/tool/error/native/EOF fixtures, loopback HTTP, live R4U Chat/Responses JSON/SSE and function-tool loops                                | Verified fixtures and selected live provider profile                                        |
| G04  | Allow/rewrite/deny/substitute/redirect/suspend, output validation, substitute original calls zero                                           | Verified tested cases                                                                       |
| G05  | Unobserved completion, cancel races, late responses, attached children, cross-service supervision, budgets/deadlines and awaited boundaries | Verified tested cases                                                                       |
| G06  | Immutable CAS history and run attachment; source versions/maps and authorized public projection                                             | Verified local profile                                                                      |
| G07  | Packed consumer-owned semantic lowerer/action/renderer; DOM components and ordered slots                                                    | Verified                                                                                    |
| G08  | Two distinct drivers and independent Map-based boundary source experiment                                                                   | Verified nominal/single-use comparison                                                      |
| G09  | Actual codec loopback plus authenticated HTTP/SSE command/query/watch                                                                       | Verified                                                                                    |
| G10  | Themed Chat, IME/draft, stream/tool/cancel, safe Markdown/cards/artifacts, headless and Chromium playground                                 | Verified DOM/Chromium scenarios and cache benchmark; broader browser/device audits separate |
| G11  | Memory/SQLite atomic journal/state, reopen, crash-intent recovery, migration and durable artifacts                                          | Verified local profile                                                                      |
| G12  | Exact alpha.2 consumers and lockfiles, changelog/migration/support docs, local checks and CI matrix                                         | Verified locally; hosted CI not run                                                         |

## G-WORKFLOW

| Gate | Actual local evidence                                                                                                                                                                             | Status                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| GW01 | Basic/core consumers work without workflow imports; browser excludes executors/auth/DB; core import starts no resources                                                                           | Verified                                                  |
| GW02 | Skill discovery/activation pins content and never auto-executes; explicit pipeline binding releases activation                                                                                    | Verified                                                  |
| GW03 | Actual script → managed child agent/model → schema result → memory approval and final output                                                                                                      | Verified                                                  |
| GW04 | Separate pipeline compiler/interpreter with sequential checks, lexical branches, bounded repeat/parallel and step timeouts                                                                        | Verified supported profile                                |
| GW05 | Missing engine/profile/format/capability/handler, invalid block/field/digest fail before the unsupported execution                                                                                | Verified tested cases                                     |
| GW06 | Failed assertions block writes; changed submission inputs conflict; duplicate approval applies once; cancel/late responses cannot resume                                                          | Verified tested races                                     |
| GW07 | Independent native state owner: submit receipt loss, attach/reconcile, native actions/guarantees; stable agent-step attachment                                                                    | Verified fake native port; no product compatibility claim |
| GW08 | Required hook timeout/malformed output blocks; report policy, matcher, scope, concurrent once and recursion                                                                                       | Verified tested policies                                  |
| GW09 | Fixed script bytes, explicit channels/capture/schema/processor errors and timeout; authenticated audience/method/profile/expiry grants; parent budgets/revocation/cancel; one shared tool attempt | Verified local IPC/process profile                        |
| GW10 | Generic endpoint/controller/default DOM shows phase/result/wait/action, owner response works without custom renderer, native raw state stays private                                              | Verified                                                  |

The conformance catalog is broader than these assertions. Durable/native production
adapters require their own WD recovery suites and exact source/version evidence.
Checkpoint storage does not enable resume. Closing observation never cancels work;
explicit owner cancellation/shutdown does, with unresolved cleanup preserved.

## Reproduction

ACP agent integration has separate local evidence: 18 focused tests using official
SDK 1.8.0 and owned stdio children, plus successful R4U Chat Completions/Responses
text requests through the example ACP client. This supports the bounded profile
in [ACP integration](acp.md); it does not imply Zed GUI verification or complete
ACP/MCP conformance. Core gate scope is unchanged.

```sh
npm ci
npm run format:check
npm test
npm run test:consumers
npm run preview:build
npm run measure
npm run measure:ui
```

Integration tests need loopback socket/subprocess permissions. They were executed
with reviewed workspace sandbox escalation, use temporary local roots and require
no provider credentials. The separate opt-in `npm run smoke:provider` uses `.env`
and passed the selected R4U JSON/SSE/function-tool profile. Hosted CI was not run;
Ollama live-provider validation remains separate. The [browser playground](playground.md)
has local Chromium interaction and responsive-layout evidence; this is not a complete
browser/device/accessibility audit.

[Validation log](validation.log) records commands and outcomes. [Candidate evidence](evidence.json)
records the pre-refactor environment, code revision/digests and measurements.
Current workspace verification is appended to the validation log; historical hashes
do not describe the current package layout. Cold-import numbers
are one local measurement, not a universal performance guarantee.
