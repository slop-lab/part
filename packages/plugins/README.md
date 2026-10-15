# @slop-lab/part-plugins

Optional portable implementations for part: agent presets/drivers, model providers,
workflow engines, hooks/skills, script bridges and deterministic test fixtures.
Depends only on the matching `@slop-lab/part` version; no Node or browser UI dependency.

```js
import { createAgent } from '@slop-lab/part-plugins/agent';
import { createOllamaAdapter } from '@slop-lab/part-plugins/providers/ollama';
import { createPipelineEngine } from '@slop-lab/part-plugins/workflows/pipeline';
```

Plugins are grouped here rather than given one package each. Execution implementations
remain explicit and opt-in. Trusted code and memory workflows do not provide durable
stack recovery. Ollama real-provider smoke remains unverified.

Build in the workspace with `npm run build --workspace @slop-lab/part-plugins`.
This is a private experimental package; pin its exact version and its core dependency.

`@slop-lab/part-plugins/providers/openai-compatible` exports `createOpenAICompatibleAdapter`
for text/function-tool Chat Completions over JSON or SSE. It works with the local
Node mock and an explicitly configured compatible endpoint. This profile does not
implement Responses API, media or provider-hosted tools. Live R4U smoke with
`gpt-6-luna` passed JSON/SSE text and a function-tool loop.
See [provider smoke](../../docs/provider-smoke.md).

`@slop-lab/part-plugins/providers/openai-responses` exports `createOpenAIResponsesAdapter`
for stateless Responses text/runtime-function calls over JSON or SSE, with native
reasoning replay. Use the opt-in smoke test to check a configured live endpoint.
See [Responses usage and limits](../../docs/openai-responses.md). Media, hosted tools,
background requests and stored conversation/continuation handles are unsupported.

`@slop-lab/part-plugins/acp` exports `createAcpAgent` for ACP v1 sessions, text streaming,
tool permission requests and cancellation over a structural connection port.
Hosts configure an agent per session; the plugin installs permission middleware.
It has no Node or ACP SDK dependency. See [ACP integration](../../docs/acp.md)
for the Node transport, MCP connector, executable examples and profile limits.
