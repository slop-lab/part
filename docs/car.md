# CAR software-engineering profile

CAR is a usable initial single-host software-engineering profile assembled from
the public `part` packages. It owns one canonical workspace and one private state
directory, runs a coding root with bounded managed subagents, exposes a real
authenticated HTTP/SSE client surface, and serves the CAR Workbench. CAR is a
private npm workspace; the repository root and all four SDK packages remain
independent of it and have no dependency on `@slop-lab/car`.

This document describes the implemented source in [`car/src`](../car/src), the
workspace/process tools in [`packages/node/src/swe`](../packages/node/src/swe),
and the CAR tests in [`tests`](../tests). It does not infer capabilities from a
design document or from an external product.

## Start locally without an upstream model

Node.js 24.22.0 or newer is required. Use absolute workspace paths and a private,
dedicated state directory.

```sh
npm ci
npm run car:build
mkdir -m 700 /tmp/car-state
npm run car -- serve \
  --root /absolute/path/to/workspace \
  --state /tmp/car-state \
  --mock-session /tmp/car-model-session.json \
  --workflows true
```

The default provider is `interactive`: CAR starts the loopback mock provider and
does not contact an upstream model. `--mock-session` is created exclusively with
mode `0600`, so choose a new filename. Startup emits one JSON object with the
browser `url`, generated or `CAR_TOKEN` bearer token, canonical `root`, mock model
and control credentials, and `"dim":"disabled"`. Open the URL and enter the
token. The token remains in that browser tab and is sent only as an Authorization
header.

In another terminal, inspect and answer model requests:

```sh
npm run mock:provider -- pending --session /tmp/car-model-session.json --wait-ms 1000
npm run mock:provider -- inspect --session /tmp/car-model-session.json --id REQUEST_ID
npm run mock:provider -- respond --session /tmp/car-model-session.json \
  --id REQUEST_ID --decision-id operator/final --text 'Done with evidence.'
npm run mock:provider -- verify --session /tmp/car-model-session.json
```

Use `--reply FILE` instead of `--text` to return function calls, chunks, usage,
or deliberate error/raw replies. The complete existing CLI supports `serve`,
`pending`, `inspect`, `respond`, `reject`, `status`, `transcript`, `verify`,
`fixture`, and `stop`; see [mock-provider workflows](mock-provider.md). A fixed
mock is started separately and then supplied to CAR as a normal Chat-compatible
endpoint:

```sh
npm run mock:provider -- serve --mode fixed --project car-fixed \
  --fixture /tmp/car.fixture.json --session /tmp/car-fixed-session.json
# Pass that session's baseURL/apiKey as OPENAI_BASE_URL/OPENAI_API_KEY, set
# OPENAI_MODEL, and use --provider chat. Fixed mode compares ordered request JSON.
```

`npm run car:demo` builds the UI and runs a credential-free end-to-end example
through actual loopback model HTTP, CAR HTTP commands/queries, SSE observation,
hash-addressed editing, a host command alias, cancellation, and reopened history.

## CLI

```text
node car/src/cli.mjs serve --root PATH --state PATH [options]
node car/src/cli.mjs recover-lock --state PATH
```

| Option                                              | Implemented behavior                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--host ADDRESS`, `--port NUMBER`                   | Bind the browser/API server; defaults to `127.0.0.1` and an ephemeral port.                               |
| `--provider interactive\|chat\|responses\|messages` | Interactive local mock by default; otherwise use Chat Completions, Responses or Anthropic Messages.       |
| `--base-url URL`, `--model NAME`                    | Compatible endpoint and model.                                                                            |
| `--headers JSON`                                    | Additional request headers as a JSON object.                                                              |
| `--edit-mode hash\|exact`                           | Select the input contract of local `swe_edit`; default `hash`.                                            |
| `--trace metadata\|full`                            | Metadata is default. Full mode persists compiled model context and encoded request bodies.                |
| `--mock-session PATH`                               | Exclusively write credentials for CAR's interactive mock.                                                 |
| `--operator-session PATH`                           | Bind six mock-control tools to a separate target mock session; managed children may use them.             |
| `--toolset-checkout PATH`                           | Start an already-built `PATH/dist/mcp.js` over stdio MCP. It does not install or build the checkout.      |
| `--tools ID,ID`, `--toolset-profile p0\|p1`         | Exact remote allowlist and server profile (`p0` default). An empty list grants no installed remote tools. |
| `--workspace-provider local\|external`              | Keep built-in workspace tools, or require the configured external toolset. Process tools remain local.    |
| `--workflows true`                                  | Load pinned `*.pipeline.json` definitions from `.agents/workflows`. Other values are rejected.            |
| `--check JSON_ARGV`                                 | Run a host-selected completion command for every proposed completion; timeout 120 seconds.                |

Set `CAR_TOKEN` to a stable token of at least 16 characters. The default
`interactive` provider remains a local mock and needs no upstream credentials.
Real `chat` and `responses` modes require an explicit model (through `--model` or
`OPENAI_MODEL`) and `OPENAI_API_KEY`; credentials remain in the server process.
The base URL defaults to `https://api.openai.com/v1` and may be changed with
`--base-url` or `OPENAI_BASE_URL`. It must be an HTTP(S) origin/path without
embedded credentials, query, or fragment; plain HTTP is accepted only for
loopback. The `messages` protocol uses `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
optional `ANTHROPIC_HEADERS`, and `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com/v1`).
The transport streams and has a five-minute default timeout.

Additional deployment-specific headers may be supplied with `--headers` or the
`OPENAI_HEADERS` JSON string, for example `{"x-project":"example"}`. Generic
headers cannot override `Authorization`, `Content-Type`, `Host`, `Content-Length`, or
`Connection`. The Messages profile also reserves `x-api-key`. Keep gateway onboarding details and private
credentials out of product configuration and the repository. For example:

```sh
OPENAI_API_KEY=set-locally OPENAI_MODEL=model-id npm run car -- serve \
  --root /abs/repo --state /private/state --provider responses \
  --headers '{"x-project":"example"}'
```

This documents configuration only; it does not claim that paid model access or
deployment authentication has been verified.

`--check` is a nonempty ordinary JSON argv array, not shell syntax. The first
element must be an absolute executable or a resolved host alias. CAR always adds
`node`; it resolves `git`, `npm`, `npx`, and `pnpm` from absolute `PATH` entries
when available. For example:

```sh
npm run car -- serve --root /abs/repo --state /private/state \
  --check '["npm","test"]'
npm run car -- serve --root /abs/repo --state /private/state \
  --check '["/usr/bin/make","test"]'
```

The validator records exit status and passes only for a successful, untruncated
process result. It is host evidence, not acceptance of a model's prose claim.
Child processes receive a dedicated state-owned home, selected `PATH`,
`C.UTF-8`, and explicit per-call environment entries—never provider credentials.
Shell execution is disabled by the CLI profile.

## Coding tools and managed subagents

The default local workspace surface is:

- `swe_read`: bounded UTF-8 content, SHA-256 full-content digest, and one-based
  lines carrying the first eight hex characters of SHA-256(line text).
- `swe_list`: bounded recursive or shallow listing without following symlinks.
- `swe_search`: literal bounded UTF-8 search with line/hash results.
- `swe_write`: atomic create with `absent:true`, or replacement with the expected
  full-file digest.
- `swe_edit`: full-file digest plus either `{line,hash,newText}` edits in `hash`
  mode or one uniquely occurring `oldText` and `newText` in `exact` mode.
- `swe_exec`, plus `swe_process_start/status/wait/read/cancel`: supervised command
  execution, bounded output/artifacts, timeout and process-tree cleanup.

Workspace paths must be relative and remain under the canonical root. Defaults
are 1 MiB files, 100,000 output characters, and 1,000 entries. Writes serialize
inside the same runtime and recheck their precondition before atomic replacement.
This is optimistic coordination, not hostile-filesystem isolation: digest checks
and rename are not an OS CAS, and the workspace owner must prevent hostile hard
links or external actors.

The root also receives `swe_subagent`. Children use the same model/runtime graph,
cannot recursively delegate, and by default can call only available
`swe_read`, `swe_list`, `swe_search`, and target mock-control tools. Defaults are
32 model invocations, 64 tool dispatches, 4 child runs, and 96 executor attempts;
the root coding loop defaults to 32 turns. Parent budgets and cancellation apply
to managed children.

## Respond to a separate target LLM request

`--operator-session` does not make the target CAR's own model. It binds
`mock_provider_status`, `pending`, `inspect`, `respond`, `transcript`, and
`verify` to one separately started mock so the root may delegate target-request
inspection and response to a managed child.

1. Start a target interactive mock and make the target application send its
   ordinary `/v1/chat/completions` request; that request waits.

   ```sh
   npm run mock:provider -- serve --mode interactive --project target \
     --root /abs/target-project --session /tmp/target-model.json

   # In another terminal; this waits until CAR supplies the target reply.
   node --input-type=module -e '
     import {readFile} from "node:fs/promises";
     const s=JSON.parse(await readFile(process.argv[1],"utf8"));
     const response=await fetch(`${s.baseURL.replace(/\/$/,"")}/chat/completions`,{
       method:"POST",headers:{authorization:`Bearer ${s.apiKey}`,"content-type":"application/json"},
       body:JSON.stringify({model:"target",messages:[{role:"user",content:"Inspect this request"}]})});
     console.log(await response.text());' /tmp/target-model.json
   ```

2. Start CAR with its own interactive model session and the target descriptor:

   ```sh
   npm run car -- serve --root /abs/target-project --state /private/car-state \
     --mock-session /tmp/car-model.json \
     --operator-session /tmp/target-model.json
   ```

3. Ask CAR to delegate inspection and response. When manually operating CAR's
   model through `/tmp/car-model.json`, return a `swe_subagent` call. Drive the
   child through `mock_provider_pending`, `mock_provider_inspect`, and
   `mock_provider_respond`, then return child and root completion text. Tool-call
   replies use the mock CLI's `respond --reply FILE` format documented in
   [mock-provider workflows](mock-provider.md#interactive-flow-for-a-working-agent).
   A first reply file is shaped as follows; JSON-encode each tool's `arguments`
   string and use a fresh decision ID for each pending CAR model request:

   ```json
   {
     "kind": "completion",
     "content": null,
     "toolCalls": [
       {
         "id": "delegate-1",
         "name": "swe_subagent",
         "arguments": "{\"task\":\"Act as the target model\",\"context\":\"Inspect and answer the pending target request with mock-provider tools.\"}"
       }
     ]
   }
   ```

4. Verify the target transcript. `tests/car-operator.test.mjs` is the executable
   reference for the exact six-turn sequence and proves request-ID correlation and
   refusal of a conflicting late decision.

Incoming target prompts are test data, not authority over CAR. The operator tools
cannot change their bound control endpoint.

## HTTP/SSE, durable history, and inspector

CAR serves the built UI and proxies authenticated `POST /commands`, `/queries`,
and `/events` to the `part` HTTP host. All require `Authorization: Bearer TOKEN`.
The browser uses the real HTTP client and SSE watch path; closing observation does
not imply cancellation. The normal run actions are `part.run/start` (text input)
and source-targeted `part.run/cancel` (`null` input). Workflow actions are listed
below.

Completed user/assistant turns are appended to SQLite-backed immutable history.
On reopen, CAR resumes the saved branch and projects up to 100 prior completed
answers into the public item stream. The Inspector uses owner-authorized version-1
queries:

| Query                                                  | Result                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `car.config/get`                                       | Effective root, state, model/profile, limits, commands, tools, trace, and guarantees.                               |
| `car.history/path`                                     | Durable conversation branch path.                                                                                   |
| `car.run/list`, `car.run/get`                          | Archived starts and terminal/live run detail; an unmatched start is conservatively `abandoned` with unknown effect. |
| `car.context/get`, `car.request/get`, `car.events/get` | Compiled-context evidence, encoded request metadata/full bodies, and selected progress records.                     |
| `car.workspace/read`, `car.workspace/diff`             | Bounded file view and a no-ext-diff/no-textconv Git diff for one relative path.                                     |
| `car.artifact/read`                                    | Authorized artifact bytes as base64.                                                                                |

The Workbench provides conversation plus Runs, Workflows, History, Context,
Requests, Events, Workspace, Diff, Artifact, and projected Items views. API values
are rendered as inert text. Headless consumers may use `openCar().endpoint` /
`hub` directly or the same HTTP port; the UI is not required for execution.

## Workflows: data by default, code only by injection

With `--workflows true`, CAR reads only regular
`.agents/workflows/*.pipeline.json` files (lexicographic order), at most 128 files
and 1 MiB each. The real workflow directory must remain inside the workspace.
Each JSON value must declare `format:"part.pipeline"`, `version:1`, a nonempty
`id`, input/output schema references, nonempty `steps`, and `result`. CAR hashes
the parsed definition, compiles every registration before serving, and runs the
`default` profile with runner-enforced control. The loader never imports code from
the workspace definition directory.

The composed pipeline supports the installed pipeline primitives, including
bounded scripts, the managed `coding` agent, assertions, and waits. Script source
is a relative, digest-pinned snapshot and only the `node` interpreter is installed.
Waits project `part.workflow/respond`; starts/cancellation use
`part.workflow/start` and `part.workflow/cancel`. The Workbench discovers pinned
definitions, submits JSON input once, shows waits, and does not automatically
repeat unknown delivery.

To try the checked-in agent → approval → assert example, copy
[`car/examples/review.pipeline.json`](../car/examples/review.pipeline.json) into
your workspace's `.agents/workflows/` before starting CAR with `--workflows true`.
In the Workflows tab select `car.review-with-approval` and submit
`{"prompt":"Read README.md and give a concise review."}`. The review is not a
successful workflow until the projected response action receives
`{"approved":true}` and the final assertion passes. It does not publish or apply
anything after approval.

There are three different integration forms:

| Form          | How it enters CAR                                                                                                           | Source path                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Data pipeline | CLI `--workflows true` or `openCar({workflows:true})`; JSON only                                                            | [`car/src/workflows.mjs`](../car/src/workflows.mjs)                                           |
| Trusted code  | Programmatic `openCar({workflows:{codeDefinitions:[...]}})`; explicit host-injected async functions, never loaded from JSON | [`car/src/workflow-surface.mjs`](../car/src/workflow-surface.mjs), plugin `workflows/code.js` |
| Native engine | Call `createCarWorkflowRegistry({engines, registrations,...})` from a trusted host                                          | [`car/src/workflows.mjs`](../car/src/workflows.mjs), plugin `workflows/host.js`               |

Code definitions hash function text and schema references, not mutable closure
state, and have no replay. Native scheduling/reconciliation guarantees belong to
the injected engine. The independent native fixtures establish the port contract,
not compatibility with a named external workflow product. Durable pipeline/code
stack resume is not implemented.

## Toolset-server and optional gateway evidence

`--toolset-checkout /absolute/checkout` starts only the already-built
`dist/mcp.js` with fixed launch environment: CAR's root, principal `part-car`,
workspace `local`, selected `p0`/`p1` profile, exact allowlist, and
`STATE/toolset.sqlite`. MCP server command, args, and environment are pinned by an
allow callback. CAR does not install dependencies or build the checkout. An empty
`--tools` value exposes no installed remote tools; include every required tool ID.
`--workspace-provider external` removes CAR's five local workspace tools and
requires this connection. It does not remove local process tools.

The connector API also accepts an absolute `executable` plus `executableArgs` for
a later published command, but those options are not exposed by the current CAR
CLI. This is intentional future configuration, not an installed command claim.
See the pinned toolset-server
[host integration reference](https://github.com/slop-lab/toolset-server/blob/107ea919f1ea25ea4c67d9fdcad5642438421497/docs/host-integration.md)
and [P1 hashline API](https://github.com/slop-lab/toolset-server/blob/107ea919f1ea25ea4c67d9fdcad5642438421497/docs/p1-hashline.md).

Historical integration research used Router4u as an optional service through the
same generic OpenAI-compatible HTTP interface documented above. Router4u is not
embedded, started, or represented by dedicated product configuration in CAR;
deployment-specific onboarding and private credentials remain external. Both
protocol paths stream. The pinned Router4u
[API reference](https://github.com/slop-lab/router4u/blob/a6709ad6e892d4b26bd7d7cf611a76b29436c0a0/docs/api.md)
is retained as the source for the Chat/Responses boundaries evaluated in that
research, not as current setup guidance.

DIM is different: CAR never starts, probes, or contacts it. The integration
surface evaluated at
[`80bcf8c…`](https://github.com/slop-lab/dev-infra-manager/tree/80bcf8c315c923de8f0c53b1ccdde30538e3c215)
was a CLI contract; the current environment's older DIM host was not tested against it. The optional
`part-node` DIM adapter has fake-only tests; it is not wired into CAR and
establishes no live compatibility.

## Verification matrix

This table separates source/test evidence from external probes. It deliberately
contains no total test count.

| Axis          | Exercised profile                                                      | Evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace ACI | Local `hash` and `exact`; toolset P1                                   | Repository tests cover local stale-digest/hash/exact behavior. At toolset-server `107ea919…`, an actually built checkout connected through the CAR MCP connector and returned a five-tool catalog including four MCP controls; one read call succeeded. The native effect of that external read was not independently established.                                                                                                                                      |
| Model source  | Manual interactive mock; exact fixed mock; local Router4u fake backend | Interactive/fixed paths are local mock tests. Router4u `a6709ad…` was run as a real gateway with a local fake backend; both Chat and Responses passed. No paid or live inference was made.                                                                                                                                                                                                                                                                              |
| Completion    | Default coding driver; validating driver                               | Default completion accepts a structurally valid terminal model response. Injected validation and CLI `--check` can reject completion; tests cover a rejecting validator. This is not a claim that every run is validated.                                                                                                                                                                                                                                               |
| Workflow      | Injected code; loaded pipeline; injected native engine                 | Code and pipeline engines run through shared execution services; CAR's script/agent/wait/approval path is tested. Native tests prove interface boundaries only. Source paths are listed above.                                                                                                                                                                                                                                                                          |
| Client        | Headless endpoint/hub; browser HTTP/SSE                                | Runtime and end-to-end tests cover durable reopen, authorization, cancellation, and real loopback HTTP/SSE. Browser QA recorded Chromium at widths 375/768/1280, 31 screenshots including invalid-token handling, Korean input, streaming, `node` alias execution, workflow approval, every inspector tab, and cancellation; page errors were 0. Two independent visual reviews recorded PASS. These are local UI observations, not broad browser/device certification. |

Research motivation is intentionally not product evidence. The
[SWE-agent NeurIPS 2024 paper](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html)
motivates agent-specific interfaces, and Anthropic's
[Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
motivates evaluation-driven, bounded, meaningful tool surfaces. CAR has not
measured a performance gain from either design choice.

Hash-addressed editing is similarly related work, not wire compatibility:

- CAR's local implementation is exactly [`hash.ts`](../packages/node/src/swe/hash.ts)
  plus [`files.ts`](../packages/node/src/swe/files.ts): SHA-256 content digest and
  eight-hex per-line preconditions.
- Oh My OpenAgent's evolving public
  [`hashline-core` validation](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/hashline-core/src/validation.ts)
  and [hash computation](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/hashline-core/src/hash-computation.ts)
  demonstrate a different `LINE#HASH` design.
- Gajae Code's [hashline implementation](https://github.com/Yeachan-Heo/gajae-code/tree/main/packages/coding-agent/src/hashline)
  is another independently evolving design.
- Oh My Pi inspired this family of interfaces, but no OMP format compatibility
  has been verified. CAR does not parse any of these external formats.

## Security, ownership, and limits

- State is single-owner. On POSIX its directory must be mode `0700`; the lock is
  `0600`. The state binds to one canonical workspace, and history, artifacts,
  SQLite, and full traces are sensitive.
- `recover-lock` takes a separate recovery lock, validates metadata, refuses a
  live PID, and refuses unresolved-resource evidence. Unknown metadata requires
  manual inspection and reconciliation.
- Metadata tracing stores context/request summaries. `full` also stores model
  context and encoded request bodies. There is no automatic redaction; credentials
  remain server-only but prompts, tool data, and source can be sensitive.
- Background processes have an explicit CAR runtime owner. Shutdown requests
  cancellation and process-tree cleanup, but unconfirmed cleanup is preserved as
  unresolved/unknown evidence. Cleanup is not rollback of external effects.
- SQLite history is durable for completed conversation records and CAR archives.
  Command dedupe is memory-only. A prior start without terminal evidence is shown
  as abandoned/unknown and requires reconciliation.
- CAR currently supports one active conversation writer. It is not a complete IDE:
  there is no full editor, interactive PTY UI, automatic Git/worktree team manager,
  arbitrary-stack checkpoint/resume, or distributed isolation. Toolset-server P1
  may expose optional PTY/LSP/kernel/workcopy capabilities when explicitly allowed,
  but CAR does not claim S4-style integrated automation for them.
- The browser audit is local Chromium evidence, not production-scale history,
  accessibility, cross-browser, or device certification. Tests establish their
  stated assertions, not all inputs or races.

## Programmatic API

`@slop-lab/car` is private and declares only `.` → `src/runtime.mjs`. Its exported
entry is:

```js
import { openCar } from '@slop-lab/car';

const car = await openCar({
  root: '/absolute/workspace',
  stateDirectory: '/private/state',
  model, // ConfiguredModel
  editMode: 'hash',
  trace: 'metadata',
  workflows: true,
});

const result = await car.agent.generate('Inspect and fix the issue.');
const config = await car.endpoint.query(
  { queryId: 'car.config/get', version: 1, input: null },
  context,
);
await car.close();
```

Required options are `root`, `stateDirectory`, and a configured `model`. Optional
host injection includes `context`, `editMode`, `trace`, `allowShell`, execution
`limits`, tool `middleware`, a completion `validate` function or
`completionCommand`, target mock `operator`, external tools/schemas/executors,
workflow options, and local/external workspace selection. The result contains
`agent`, `endpoint`, watch `hub`, projection `archive`, startup `recovery` evidence,
and idempotent `close()`.

`createCarModel`, `startCarServer`, `createCarWorkflowRegistry`, and other files
under `car/src` are source-level composition helpers, not additional declared
package exports. Consumers needing stable contracts should depend on the four SDK
packages documented in [implemented contracts](api.md), not deep-import CAR.
