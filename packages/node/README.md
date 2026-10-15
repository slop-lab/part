# @part/node

Node.js adapters for part: POSIX script processes, authenticated loopback bridge,
HTTP hosting, SQLite, immutable file artifacts and directory package snapshots.
Depends only on the matching `@part/core` version. Node >=22.18 is required;
process-group execution currently requires POSIX.

```js
import { createNodeScripts } from '@part/node/scripts';
import { startHttpHost } from '@part/node/host/http';
import { openSqliteStore } from '@part/node/storage/sqlite';
```

Resources open only through explicit factory calls. The bridge accepts core ports,
so this package does not require the portable plugin bundle. TypeScript applications
using the HTTP host need Node typings for its IncomingMessage callback.

Build in the workspace with `npm run build --workspace @part/node`.
This is a private experimental package; pin its exact version and its core dependency.
