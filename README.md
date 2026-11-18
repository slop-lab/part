# part

Progressive agent runtime: a small environment-independent core with optional
plugins and separate Node and browser packages.

| Package                  | Responsibility                                                                                              | Runtime dependencies |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------- |
| `@slop-lab/part`         | Contracts, composition, operations, model/tool ports, context, storage ports and client protocol            | None                 |
| `@slop-lab/part-plugins` | Agent presets/drivers, model providers, workflows, hooks/skills, script bridge and test fixtures            | `@slop-lab/part`     |
| `@slop-lab/part-node`    | Cross-platform script processes, loopback bridge, HTTP host, SQLite, file artifacts and directory snapshots | `@slop-lab/part`     |
| `@slop-lab/part-browser` | DOM/headless UI, renderers, workflow forms, Inspector/Workbench and CSS                                     | `@slop-lab/part`     |

The repository root is a private npm workspace, not an installable aggregate SDK.
Each package publishes its `dist` directory as the package root, with independent
build output and a local tarball.
Node.js 24.22.0 or newer is required. Packages use the MIT license.
Plugins are grouped in one package; individual plugins do not each need a package.
Core does not import the other packages, and browser/Node adapters communicate
through core contracts rather than depending on each other or the plugin bundle.

## Development setup

```sh
mise run setup
mise exec -- just example
```

The setup task uses mise's Node.js, Just, and pnpm toolchain and installs the
workspace packages from `package-lock.json`. CAR exposes pnpm to tools that opt
into its command allowlist. Git is a system prerequisite for checking out the
repository and for CAR's Git operations.

Browser tests use Chromium matched to the workspace's Playwright version.
Run `mise run browser:install` before `mise exec -- npm run test:browser`.
On Linux, Playwright's `install --with-deps chromium` also installs required system
libraries. See [browser verification](docs/playground.md#validation).

With an existing Node.js installation, use the npm commands directly.

```sh
npm ci
npm run check # TypeScript, JS/MJS type checks, package boundaries, and QG rules
npm test
npm run test:consumers
npm run measure
npm run preview
```

The private [`car`](car) workspace is the initial single-host software-engineering
application built on all four packages; no SDK package depends on it. Build and
start its local interactive profile with `npm run car:build` and
`npm run car -- serve --root ABS --state PRIVATE --mock-session UNIQUE --workflows true`.
The startup JSON contains the browser URL, bearer token, and local mock-control
credentials. See [CAR usage, APIs, evidence, and limits](docs/car.md).
For a real OpenAI-compatible endpoint, select `--provider chat` or `responses`,
set `OPENAI_API_KEY` and `OPENAI_MODEL`, and optionally set `OPENAI_BASE_URL`
(default `https://api.openai.com/v1`) or an `OPENAI_HEADERS` JSON string such as
`{"x-project":"example"}`. The equivalent CLI options are `--base-url`,
`--model`, and `--headers`; generic headers cannot override `Authorization`,
`Content-Type`, `Host`, `Content-Length`, or `Connection`. This is configuration
guidance, not a claim that paid model access or deployment authentication has
been verified.

For an Anthropic Messages endpoint, use `--provider messages` with `ANTHROPIC_API_KEY`
and `ANTHROPIC_MODEL`. Set `ANTHROPIC_BASE_URL` for a compatible gateway.
For integration into your own app, see the [shared provider factory](docs/api.md#compatible-model-apis)
and the [Sign in with ChatGPT SDK and examples](docs/api.md#sign-in-with-chatgpt).
Run `just siwc` to start the SIWC web PoC at
[`http://127.0.0.1:4174`](http://127.0.0.1:4174). The recipe installs dependencies
when needed and builds the workspace.

Run `just example` to open the [full browser playground](docs/playground.md) at
`http://127.0.0.1:4173` with providers from `.env` and optional ChatGPT sign-in.
Try conversation, tools, approval gates, immutable reports, validation failures and
cancellation, with request/event inspection. Scripted mode needs no key; optional
OpenAI-compatible Chat Completions and Responses run through a server that keeps
credentials out of the browser.
Import subpaths by their emitted filenames, including `.js` and directory `index.js`.
The build generates `dist/package.json` with a root export when `index.js` exists
and `"./*": "./*"` for all files, without rewriting workspace metadata.
See [build rules](docs/architecture.md#package-builds).

JS/MJS sources use `// @ts-check`; `npm run check:js` builds declarations and checks them
with `jsconfig.json`: strict typing, checked index access, unused-code checks and full
dependency declaration checks. `fixtures/type-contracts.mjs` guards against untyped
metadata, unchecked lookups and invalid test-double methods. Git enforces LF line
endings on every platform. Windows CI runs
all tests and consumer fixtures, including script execution and process-tree cleanup.
`npm test` hides successful test names and prints failures plus the full run summary.

Seven isolated consumer fixtures cover core-only,
non-coding, SWE, contracts, workflow, Node and browser installations. Every public
entrypoint is checked from separately packed packages. Portable declarations do
not require Node types; Node HTTP host declarations are checked with explicit
Node typings.

```js
import { createAgent } from '@slop-lab/part-plugins/agent/index.js';
import { fakeModel } from '@slop-lab/part-plugins/testing/index.js';

const created = createAgent({ model: fakeModel([{ text: 'Hello from part' }]) });
if (!created.ok) throw new Error(created.error.message);
const outcome = await created.value.generate('Hello');
console.log(outcome);
await created.value.dispose();
```

Local provider tests can be controlled by the working agent through a JSON CLI or
registered operator tools. Requests wait for explicit decisions; successful transcripts
can become exact fixed fixtures for automated tests. Run `npm run example:mock:fixed`
for the complete tool flow, or see [mock provider workflows](docs/mock-provider.md).

Run part as an ACP agent for editor clients with `@slop-lab/part-plugins/acp/index.js` and the
`@slop-lab/part-node/acp/index.js` stdio adapter. `npm run example:acp` demonstrates conversation and
tool permission requests using the official SDK client. See [ACP integration](docs/acp.md)
for Zed settings, session-owned MCP tools and optional live OpenAI-compatible providers.

Build local packages and install only the packages a dependent repository needs:

```sh
npm run pack:local
# In the consumer repository, for an agent application:
npm install /path/to/part/artifacts/slop-lab-part-0.1.0.tgz \
  /path/to/part/artifacts/slop-lab-part-plugins-0.1.0.tgz
# Add slop-lab-part-node-*.tgz for Node adapters or slop-lab-part-browser-*.tgz for DOM UI.
```

Commit the consumer lockfile and pin package versions exactly. The release version
is 0.1.0. APIs are experimental; there are no compatibility
aliases for the former flat imports. The browser stylesheet is
`@slop-lab/part-browser/styles.css`. Run a single package build with
`npm run build --workspace @slop-lab/part-browser` (or another workspace name).

See [release preparation and publication](docs/releasing.md) for version updates,
verification, public npm publication and post-release checks.

Dependent projects can begin development against the pinned package tarballs.
APIs remain experimental. See
[Responses adapter](docs/openai-responses.md),
[provider smoke](docs/provider-smoke.md),
[supported contracts](docs/api.md),
[implementation coverage](docs/implementation.md), [architecture](docs/architecture.md),
[the basic example](examples/basic.mjs) and [consumer fixtures](consumers).

Core import opens no database, socket, watcher, process or timer. Plugins are trusted
code; capability declarations do not provide OS isolation.
