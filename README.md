# part

Progressive agent runtime: a small environment-independent core with optional
plugins and separate Node and browser packages.

| Package         | Responsibility                                                                                     | Runtime dependencies |
| --------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| `@part/core`    | Contracts, composition, operations, model/tool ports, context, storage ports and client protocol   | None                 |
| `@part/plugins` | Agent presets/drivers, Ollama provider, workflows, hooks/skills, script bridge and test fixtures   | `@part/core`         |
| `@part/node`    | POSIX script processes, loopback bridge, HTTP host, SQLite, file artifacts and directory snapshots | `@part/core`         |
| `@part/browser` | DOM/headless UI, renderers, workflow forms, Inspector/Workbench and CSS                            | `@part/core`         |

The repository root is a private npm workspace, not an installable aggregate SDK.
Each package has explicit exports, independent build output and a local tarball.
Plugins are grouped in one package; individual plugins do not each need a package.
Core does not import the other packages, and browser/Node adapters communicate
through core contracts rather than depending on each other or the plugin bundle.

```sh
npm ci
npm run check
npm test
npm run test:consumers
npm run measure
npm run preview
```

The preview opens at `http://127.0.0.1:4173` with simulated streaming, owner
cancellation and custom cards. Seven isolated consumer fixtures cover core-only,
non-coding, SWE, contracts, workflow, Node and browser installations. Every public
entrypoint is checked from separately packed packages. Portable declarations do
not require Node types; Node HTTP host declarations are checked with explicit
Node typings.

```js
import { createAgent } from '@part/plugins/agent';
import { fakeModel } from '@part/plugins/testing';

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

Build local packages and install only the packages a dependent repository needs:

```sh
npm run pack:local
# In the consumer repository, for an agent application:
npm install /path/to/part/artifacts/part-core-0.1.0-alpha.2.tgz \
  /path/to/part/artifacts/part-plugins-0.1.0-alpha.2.tgz
# Add part-node-*.tgz for Node adapters or part-browser-*.tgz for DOM UI.
```

Commit the consumer lockfile and pin package versions exactly. Packages are private
and have not been published to npm. APIs are experimental; there are no compatibility
aliases for the former flat imports. The browser stylesheet is
`@part/browser/styles.css`. Run a single package build with
`npm run build --workspace @part/browser` (or another workspace name).

Dependent projects can begin local development. R4U authentication and discovery
passed, but its configured route supports Responses only; the current Chat Completions
adapter cannot complete the live smoke. Formal G-BASE signoff remains open. See
[provider smoke](docs/provider-smoke.md),
[gate evidence](docs/gates.md), [supported contracts](docs/api.md),
[implementation coverage](docs/implementation.md), [architecture](docs/architecture.md),
[the basic example](examples/basic.mjs) and [consumer fixtures](consumers).
The recorded pre-refactor evidence is historical; current checks use the workspace layout.

Core import opens no database, socket, watcher, process or timer. Plugins are trusted
code; capability declarations do not provide OS isolation.
