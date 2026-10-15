# @part/plugins

Optional portable implementations for part: agent presets/drivers, model providers,
workflow engines, hooks/skills, script bridges and deterministic test fixtures.
Depends only on the matching `@part/core` version; no Node or browser UI dependency.

```js
import { createAgent } from '@part/plugins/agent';
import { createOllamaAdapter } from '@part/plugins/providers/ollama';
import { createPipelineEngine } from '@part/plugins/workflows/pipeline';
```

Plugins are grouped here rather than given one package each. Execution implementations
remain explicit and opt-in. Trusted code and memory workflows do not provide durable
stack recovery. Real-provider smoke is deferred.

Build in the workspace with `npm run build --workspace @part/plugins`.
This is a private experimental package; pin its exact version and its core dependency.
