# part

Progressive agent runtime: an embedded agent SDK with optional composition,
model/tool execution, context, persistence, client/UI, skills, scripts, and workflows.

**Local integration alpha:** non-coding, SWE, and contract consumers run against a
packed `0.1.0-alpha.1` package. Fake-provider prototypes can start against this
version. Formal G-BASE signoff remains pending the real-provider smoke test, which
was explicitly deferred. See [gate evidence](docs/gates.md) and
[supported contracts and limits](docs/api.md).

```sh
npm ci
npm test
npm run test:consumers
npm run measure
npm run preview
```

The preview opens at `http://127.0.0.1:4173`. It demonstrates simulated streaming,
owner cancellation, custom cards, and CSS theme replacement. Tests also exercise
Chat against the actual embedded agent and a real local HTTP endpoint.

```js
import { createAgent } from 'part/agent';
import { fakeModel } from 'part/testing';

const created = createAgent({ model: fakeModel([{ text: 'Hello from part' }]) });
if (!created.ok) throw new Error(created.error.message);
const outcome = await created.value.generate('Hello');
console.log(outcome);
await created.value.dispose();
```

For a dependent repository, build and install the local tarball:

```sh
npm run build
npm pack --cache /tmp/part-npm-cache
# In the consumer repository:
npm install /path/to/part-0.1.0-alpha.1.tgz
```

Commit the consumer lockfile and pin the package exactly. This package is private
and has not been published to npm. Public APIs are experimental; changes require
consumer regression tests and changelog/migration notes.

Use [the basic tool example](examples/basic.mjs),
[packed consumer fixtures](consumers), and [architecture decisions](docs/architecture.md)
for more detail. Core import opens no database, socket, watcher, process, or timer.
All runtime plugins are trusted code; capability declarations do not provide OS isolation.
