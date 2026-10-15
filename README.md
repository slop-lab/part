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
Each package has explicit exports, independent build output and a local tarball.
Plugins are grouped in one package; individual plugins do not each need a package.
Core does not import the other packages, and browser/Node adapters communicate
through core contracts rather than depending on each other or the plugin bundle.

```sh
npm ci
npm run check # TypeScript, JS/MJS type checks, and package boundaries
npm test
npm run test:consumers
npm run measure
npm run preview
```

The [browser playground](docs/playground.md) opens at `http://127.0.0.1:4173`.
Try conversation, tools, approval gates, immutable reports, validation failures and
cancellation, with request/event inspection. Scripted mode needs no key; optional
R4U Chat Completions and Responses run through a server that keeps credentials out
of the browser. Use `npm run test:browser` after `npx playwright install chromium`.
JS/MJS sources use `// @ts-check`; `npm run check:js` builds declarations and checks them
with `jsconfig.json`. Git enforces LF line endings on every platform. Windows CI runs
all tests and consumer fixtures, including script execution and process-tree cleanup.
`npm test` hides successful test names and prints failures plus the full run summary.

Seven isolated consumer fixtures cover core-only,
non-coding, SWE, contracts, workflow, Node and browser installations. Every public
entrypoint is checked from separately packed packages. Portable declarations do
not require Node types; Node HTTP host declarations are checked with explicit
Node typings.

```js
import { createAgent } from '@slop-lab/part-plugins/agent';
import { fakeModel } from '@slop-lab/part-plugins/testing';

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

Run part as an ACP agent for editor clients with `@slop-lab/part-plugins/acp` and the
`@slop-lab/part-node/acp` stdio adapter. `npm run example:acp` demonstrates conversation and
tool permission requests using the official SDK client. See [ACP integration](docs/acp.md)
for Zed settings, session-owned MCP tools and optional live R4U providers.

Build local packages and install only the packages a dependent repository needs:

```sh
npm run pack:local
# In the consumer repository, for an agent application:
npm install /path/to/part/artifacts/slop-lab-part-0.1.0-alpha.2.tgz \
  /path/to/part/artifacts/slop-lab-part-plugins-0.1.0-alpha.2.tgz
# Add slop-lab-part-node-*.tgz for Node adapters or slop-lab-part-browser-*.tgz for DOM UI.
```

Commit the consumer lockfile and pin package versions exactly. Packages are private
and have not been published to npm. APIs are experimental; there are no compatibility
aliases for the former flat imports. The browser stylesheet is
`@slop-lab/part-browser/styles.css`. Run a single package build with
`npm run build --workspace @slop-lab/part-browser` (or another workspace name).

Dependent projects can begin development against the pinned package tarballs.
G-BASE passes for the selected reference profile, including live R4U Chat Completions
and Responses JSON/SSE/function-tool smoke with `gpt-6-luna`. APIs remain experimental. See
[Responses adapter](docs/openai-responses.md),
[provider smoke](docs/provider-smoke.md),
[gate evidence](docs/gates.md), [supported contracts](docs/api.md),
[implementation coverage](docs/implementation.md), [architecture](docs/architecture.md),
[the basic example](examples/basic.mjs) and [consumer fixtures](consumers).
The recorded pre-refactor evidence is historical; current checks use the workspace layout.

Core import opens no database, socket, watcher, process or timer. Plugins are trusted
code; capability declarations do not provide OS isolation.
