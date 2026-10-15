# ACP agent integration

part can run as an **Agent Client Protocol v1 agent** over stdio, for clients such
as Zed. The portable plugin owns managed agents and tool permissions; the Node
adapter owns newline-delimited JSON-RPC and optional stdio MCP processes.
Calling an external ACP agent from part is outside this implementation.

| Import                        | Factory                | Responsibility                                        |
| ----------------------------- | ---------------------- | ----------------------------------------------------- |
| `@slop-lab/part-plugins/acp`  | `createAcpAgent`       | Sessions, prompts, updates, permissions, cancellation |
| `@slop-lab/part-node/acp`     | `startAcpStdio`        | Concurrent, bounded stdio JSON-RPC peer               |
| `@slop-lab/part-node/acp/mcp` | `connectAcpMcpServers` | Authorized session-owned MCP tool processes           |

Each optional package depends only on `@slop-lab/part`. The official ACP TypeScript
SDK is a workspace **development dependency** for interoperability tests and the
example client; installed part agents do not need it.

## Run the examples

```sh
npm ci
npm run example:acp
# Repeat, approving the in-memory save_note tool:
node examples/acp/client.mjs --approve
```

The client starts `examples/acp/agent.mjs` as a child, initializes ACP, creates a
session, sends two prompts, handles a permission request, closes the session and
waits for process cleanup. The default rejects the write and verifies the tool
does not execute. `--approve` selects allow-once and completes the second turn.
Scripted mode needs no credentials and starts with a fresh model per session.
Its fixture has a finite number of replies; start a new session to repeat it.

The agent also supports the existing server-side R4U configuration:

```sh
npm run build
PART_ACP_PROVIDER=responses node examples/acp/client.mjs --live
PART_ACP_PROVIDER=chat node examples/acp/client.mjs --live
```

The agent reads the repository `.env` with Node's environment-file parser.
Set `R4U_BASE_URL`, `R4U_API_KEY` and optionally `R4U_MODEL` (default
`gpt-6-luna`) and `R4U_ROUTE`. `--live` sends one bounded text request;
it does not exercise live function calls. The default client always selects
scripted mode unless `--live` is supplied. Keys remain in the agent process.

## Connect Zed

Build the workspace first. In Zed's Agent Settings, add a custom external agent,
using absolute paths to your Node executable and this checkout:

```json
{
  "agent_servers": {
    "part": {
      "type": "custom",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/part/examples/acp/agent.mjs"],
      "env": { "PART_ACP_PROVIDER": "scripted" }
    }
  }
}
```

Select part when starting an external-agent thread. The first prompt returns
text; the next requests permission to save an in-memory note. To use your real
model instead, set `PART_ACP_PROVIDER` to `responses` or `chat` with the R4U
configuration above. The example installs only the note tool; it does not
automatically gain file editing or terminal execution from the editor.

The example rejects forwarded MCP configurations unless `PART_ACP_MCP=1` is set.
Enable this only when you intend to launch the client's trusted MCP commands;
commands must be absolute paths. Applications should supply their own explicit
`allowServer` policy. An unapproved configuration fails session setup instead of
silently dropping requested tools. Keep stdout exclusively for ACP messages:
configure Zed to run `node` directly, never `npm run example:acp` or a build script.
Zed's `dev: open acp logs` command can inspect the exchange.

The settings shape follows [Zed's external-agent documentation](https://zed.dev/docs/ai/external-agents#custom-agents).
The checked-in example has been verified with the official SDK over real child
stdio. The Zed GUI itself has not been exercised in this environment.

## Embed an agent

```js
import { createAcpAgent } from '@slop-lab/part-plugins/acp';
import { fakeModel } from '@slop-lab/part-plugins/testing';
import { startAcpStdio } from '@slop-lab/part-node/acp';
import { connectAcpMcpServers } from '@slop-lab/part-node/acp/mcp';

const host = startAcpStdio({
  createHandler: (connection) =>
    createAcpAgent({
      connection,
      connectMcp: (setup) =>
        connectAcpMcpServers({
          ...setup,
          allowServer: (server) => server.command === '/opt/tools/my-mcp-server',
        }),
      configureSession: ({ sessionId, cwd, signal, clientCapabilities }) => ({
        model: fakeModel([{ text: 'Hello through ACP' }]),
        // Supply your own model, tools, schemas, executors, middleware and budgets.
        // Use cwd as an explicit tool root; it never changes process.cwd().
      }),
    }),
});
const cleanup = await host.closed;
if (cleanup.errors.length || cleanup.unresolved.length) process.exitCode = 1;
```

`configureSession` returns ordinary agent options. Its signal lasts for the
session, including asynchronous setup and MCP ownership. It is aborted when
session setup is cancelled or the session/connection closes. The plugin merges
MCP bindings and appends permission middleware after host middleware, so host
denials still apply. A custom non-Node transport can implement the structural
`AcpConnection` port and call `agent.handle(method, params, kind, signal)`.
The transport must implement abortable outgoing permission requests and invoke
`agent.close()` on disconnect.

## Supported protocol profile

- `initialize` negotiates protocol version 1 and advertises only this profile.
- `session/new` requires an absolute `cwd` and a stdio MCP server list. Each session
  owns a separate managed agent. `cwd` is metadata until the host explicitly uses
  it for tool roots or MCP process creation. Additional directories are rejected.
- `session/prompt` accepts text and embedded text resources. Embedded resource
  URIs become labels; the agent does not fetch them. Text deltas become
  `session/update` agent-message chunks; nonstreamed final text is sent once.
- Tools emit pending, in-progress and completed/failed updates with stable IDs.
  Tool input is visible to the client for inspection. Output updates contain core
  outcome/effect evidence, not unrestricted tool result bodies. The model receives
  the actual tool result through the normal driver.
- `session/request_permission` offers allow-once and reject-once. By default all
  tools whose declared effect is not `read` require permission. Set
  `permissions: 'all'` to include read tools. Unknown choices, cancellation,
  malformed replies and permission failures never authorize a dispatch. Approval
  applies only to the current dispatcher plan; no persistent grants are stored.
- `session/cancel` remains a notification while a prompt or permission is pending.
  Prompt completion reports `cancelled`; late permission replies cannot execute
  the cancelled write. The Node peer also supports SDK `$/cancel_request` messages.
- Advertised `session/close` cancels work, awaits cleanup and frees the session
  slot. Closing the connection or reaching stdin EOF closes all owned sessions.
  Incomplete cleanup is retained in reports, including failures during setup.

Text history contains completed visible user/assistant turns in bounded memory.
It does not replay previous turns' native model/tool items, persist sessions or
recover across process restarts. Images, audio, resource links, binary resources,
session loading/listing/resuming, modes/model selection, authentication flows,
client filesystem/terminal operations and prompt-plan updates are unsupported.
Unsupported requests fail explicitly. No full ACP conformance claim is made.

Observation gaps fail and cancel the prompt rather than returning a deceptively
complete streamed answer. Provider failures expose sanitized failure codes and
effect evidence. The adapter does not automatically retry failed or uncertain
work. Standard stop reasons cover end-turn, cancellation, token limits, refusal
and model-turn limits.

## MCP tools

The Node connector initializes authorized stdio servers, pins their paginated
tool catalogs, advertises schemas and routes `tools/call` through the runtime's
external executor and single-use dispatch permits. It negotiates the tools
profile for MCP versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`.
The local fixture verifies the selected `2025-11-25` flow; arbitrary MCP product
compatibility still needs validation against that server.

`allowServer` is required, commands/cwd must be absolute, and commands run with
argv and `shell: false`. Child environments contain only `PATH`, explicitly
supplied host environment entries and the server's declared env; ambient provider
credentials are not inherited automatically. POSIX cleanup terminates the owned
process group; other platforms terminate the child. Unresolved resources remain
visible in cleanup reports.

Every MCP tool is an external effect requiring ACP permission, even when an
untrusted server advertises `readOnlyHint`. Returned results do not prove an
external write did or did not occur: effect evidence remains `unknown`. Text
content and object `structuredContent` are supported. Media and error results
fail explicitly. Arguments must be JSON objects; the remote server owns full
JSON Schema validation. Cancelling a remote call closes that server for the
session, with no automatic restart or retry. Open a new session to reconnect.

Limits are eight servers, 64 tools and 32 catalog pages. Dynamic catalog changes,
MCP HTTP/SSE, resources/prompts, sampling, roots, tasks and OAuth are outside this
connector's selected tools profile. A host may provide a different `connectMcp`
implementation while keeping the same portable ACP agent.

## Bounds and verification

Agent defaults: 16 concurrent sessions, one prompt per session, 32 completed
history turns, 256 KiB input text per prompt and a 180-second turn deadline.
Session/history exhaustion rejects admission; it never evicts a live session or
silently drops old history. Default per-turn agent budgets allow eight model
invocations and 16 tool dispatches; hosts may explicitly configure their own.

Transport defaults: 1 MiB NDJSON frames, 4 MiB queued output, 32 concurrent incoming
requests, 32 outgoing pending requests, a 120-second request timeout and a
30-second write timeout. Notifications and replies are processed independently
of long-running prompt handlers. Input/output errors, overflow and stalled writes
close the peer, reject pending requests, cancel owned work and await cleanup.

```sh
npm test
npm run test:consumers
npm run format:check
node scripts/check-architecture.mjs
```

`tests/acp.test.mjs` covers official SDK 1.8.0 interoperability, byte-split Unicode,
real child stdio, permission decisions, cancellation races, reused provider call
IDs, limits, backpressure, session cleanup and owned MCP processes. Isolated
consumers exercise portable ACP without Node adapters and Node ACP without the
plugin bundle. See [validation evidence](validation.log) for executed commands.

Protocol references: [ACP overview](https://agentclientprotocol.com/protocol/v1/overview),
[initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls),
[cancellation](https://agentclientprotocol.com/protocol/v1/cancellation),
[stdio transport](https://agentclientprotocol.com/protocol/v1/transports),
[official TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk),
[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
