# @slop-lab/part-node

Node.js adapters for part: cross-platform script processes, authenticated loopback bridge,
HTTP hosting, SQLite, immutable file artifacts and directory package snapshots.
Depends only on the matching `@slop-lab/part` version. Node >=22.18 is required;
scripts use process groups on POSIX and a Job Object supervisor on Windows.
The Windows supervisor is compiled once and cached using the C# compiler included
with .NET Framework 4.x; no separate native build tools or npm dependencies are needed.
Normal exit, cancellation and timeouts terminate descendants, including Windows
children detached from their immediate parent. Result channel fd 3 is preserved.

```js
import { createNodeScripts } from '@slop-lab/part-node/scripts';
import { startHttpHost } from '@slop-lab/part-node/host/http';
import { openSqliteStore } from '@slop-lab/part-node/storage/sqlite';
```

Resources open only through explicit factory calls. The bridge accepts core ports,
so this package does not require the portable plugin bundle. TypeScript applications
using the HTTP host need Node typings for its IncomingMessage callback.

Build in the workspace with `npm run build --workspace @slop-lab/part-node`.
This is a private experimental package; pin its exact version and its core dependency.

Local OpenAI-compatible mocks are available from `@slop-lab/part-node/testing/mock-provider`,
with operator tools at `@slop-lab/part-node/testing/mock-provider/tools`. Installed packages
provide `part-mock-provider --help`; interactive sessions wait for working-agent
decisions, and fixed sessions replay exact fixtures. See `docs/mock-provider.md` in
the repository for CLI flows, transcript export and noninteractive replay.

`@slop-lab/part-node/acp` exports `startAcpStdio`, a bounded concurrent NDJSON JSON-RPC
transport accepting a structural handler. `@slop-lab/part-node/acp/mcp` exports
`connectAcpMcpServers` for explicitly authorized, session-owned stdio MCP tools.
These adapters do not depend on the plugin bundle or the ACP SDK.
See [ACP integration](../../docs/acp.md) for agent composition and Zed settings.
