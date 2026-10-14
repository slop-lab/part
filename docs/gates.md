# Integration gate evidence

Candidate: `part@0.1.0-alpha.1`.

**Local fake-provider prototypes can start against the pinned tarball.** Formal
**G-BASE is not certified**: actual-provider smoke was explicitly deferred by the
user. G-WORKFLOW is not certified. Optional unimplemented modules and production
profiles must not be inferred from the type-only design reference.

## G-BASE

| Gate | Evidence                                                                                                                   | Status                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| G01  | Architecture ADRs, strict codecs, three packed consumers, zero runtime dependencies                                        | Verified local subset                              |
| G02  | Non-coding input → model → function tool → result; import resource/heap/time measurement                                   | Verified                                           |
| G03  | Fake text/tool/error/native/EOF decoding and actual loopback HTTP custom endpoint                                          | Verified fake subset; real provider deferred       |
| G04  | Allow/rewrite/deny/substitute/redirect/suspend, output validation and zero original substitute calls                       | Verified                                           |
| G05  | Unobserved completion, cancellation races/unknown/late responses, attached-child/deadline/budget rules, awaited boundaries | Verified tested cases                              |
| G06  | Immutable CAS history, typed context/source maps/versions, final request digest and authorized public projection           | Verified separate owner services                   |
| G07  | Consumer semantic lowerer registry and typed action; DOM custom renderer/fallback and CSS path                             | Verified local contracts                           |
| G08  | Basic and post-stop validating drivers; independent Map-based source boundary experiment                                   | Verified nominal/single-use comparison             |
| G09  | Real JSON codec loopback command/query/watch/capability parity; HTTP/SSE integration                                       | Verified                                           |
| G10  | Standalone themed preview, headless IME/draft tests, custom cards, stream/cancel against embedded agent                    | Verified DOM subset; full browser/UI quality later |
| G11  | Memory and SQLite atomic state/journal, close/reopen, crash-intent recovery without repeating effects                      | Verified local subset                              |
| G12  | Exact packed consumer version, npm lock, changelog, support limits, local CI commands and CI matrix configuration          | Verified locally; hosted CI not run here           |

The specification's entire conformance catalog is broader than the assertions in
this alpha. Test titles identify actual covered cases; a grouped test name is not
a claim that every variation in a catalog family has passed. Runtime tests,
consumer typechecking and preview building are separate evidence.

## G-WORKFLOW

| Area               | Actual evidence                                                                                                             | Remaining gate work                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Optionality        | Core/basic consumers import no skill/workflow/script host; browser bundle has no server executors or credentials            | Track costs as plugins grow                                                  |
| Skills             | Explicit discovery/activation, content mismatch/path/symlink rejection, owner release; scripts not executed                 | Broader format adapters remain separate                                      |
| Code               | Actual standalone script → managed model → typed result → approval wait                                                     | Managed child-agent vertical fixture and bridge integration                  |
| Pipeline           | Sequential validation/assert/wait and managed extension write; failed checks block writes; unsupported branch fails prepare | Only documented subset supported                                             |
| Approval/lifecycle | Response authority/schema/revision/dedupe, cancel/late response rejection, concurrent start dedupe                          | Full changed-input/binding race matrix                                       |
| External engine    | Native guarantee metadata and unknown/reconciliation key forwarding                                                         | Actual submit/attach/reconcile adapter and full native fixture               |
| Hooks              | Awaited checks, invalid decisions, once consumption, scope release and recursion rejection                                  | Full timeout/parallel failure-policy matrix                                  |
| Results/scripts    | Explicit bounded JSON capture, stale source rejection, schema result acceptance, nonzero exit enforcement                   | Authenticated script IPC grants, bridge budgets/cancel, processors/artifacts |
| Generic client/UI  | Engine snapshots/actions/observation exist                                                                                  | Generic workflow endpoint/UI still required                                  |

## Reproduction

```sh
npm ci
npm test
npm run test:consumers
npm run preview:build
npm run measure
npm run format:check
```

Tests require loopback socket and subprocess permissions. The workspace sandbox
blocks those operations, so integration commands were run with reviewed sandbox
escalation. They use temporary local roots and no provider credentials. The failed
initial sandbox-only HTTP run was an `EPERM` listen failure; its retried integration
run passed. No real-provider success or remote hosted CI run is claimed.

[Validation log](validation.log) records executed tests and consumer commands.
[Candidate evidence](evidence.json) records the environment, revision/source digests,
measurements and command results. Cold-import numbers describe one local run and
are not a universal performance guarantee.
