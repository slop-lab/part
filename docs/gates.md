# Integration gate evidence

Candidate: `@part/core`, `@part/plugins`, `@part/node` and `@part/browser` at `0.1.0-alpha.2`.

**Dependent local projects can start against the selected pinned package tarballs.** Formal G-BASE
remains open: the attempted R4U smoke is blocked by a Responses-only route; the
current adapter implements Chat Completions. See [provider smoke](provider-smoke.md).
G-WORKFLOW's local reference profile has execution evidence for every gate area.
This does not certify third-party product compatibility or durable continuation.
See [implementation coverage](implementation.md) and [support limits](api.md).

## G-BASE

| Gate | Actual evidence                                                                                                                             | Status                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| G01  | ADRs, strict codecs, seven isolated packed consumers, zero runtime dependencies                                                             | Verified local profile                                                                      |
| G02  | Input → fake model → function tool → result, cold import resources/heap/time                                                                | Verified                                                                                    |
| G03  | Text/tool/error/native/EOF decoding and real loopback custom HTTP endpoint                                                                  | Fake profile verified; R4U protocol mismatch blocks live smoke                              |
| G04  | Allow/rewrite/deny/substitute/redirect/suspend, output validation, substitute original calls zero                                           | Verified tested cases                                                                       |
| G05  | Unobserved completion, cancel races, late responses, attached children, cross-service supervision, budgets/deadlines and awaited boundaries | Verified tested cases                                                                       |
| G06  | Immutable CAS history and run attachment; source versions/maps and authorized public projection                                             | Verified local profile                                                                      |
| G07  | Packed consumer-owned semantic lowerer/action/renderer; DOM components and ordered slots                                                    | Verified                                                                                    |
| G08  | Two distinct drivers and independent Map-based boundary source experiment                                                                   | Verified nominal/single-use comparison                                                      |
| G09  | Actual codec loopback plus authenticated HTTP/SSE command/query/watch                                                                       | Verified                                                                                    |
| G10  | Themed Chat, IME/draft, stream/tool/cancel, safe Markdown/card/components/artifacts and headless paths                                      | Verified DOM profile and 1,001-item/200-update cache benchmark; real browser audit separate |
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
and currently stops at R4U protocol discovery. No real-provider completion success
or remote CI execution is claimed.

[Validation log](validation.log) records commands and outcomes. [Candidate evidence](evidence.json)
records the pre-refactor environment, code revision/digests and measurements.
Current workspace verification is appended to the validation log; historical hashes
do not describe the current package layout. Cold-import numbers
are one local measurement, not a universal performance guarantee.
