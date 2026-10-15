# @part/browser

Optional DOM/headless presentation for part: Chat, renderers, workflow forms,
Inspector/Workbench and styles. Depends only on the matching `@part/core` version.
No Node implementations, agent presets, providers or workflow engines are included.

```js
import { createChat } from '@part/browser/dom';
import { createController } from '@part/core/client';
import '@part/browser/styles.css';
```

Connect through core client contracts. Browser UI does not own execution; closing an
observer does not cancel a run. The CSS import assumes a bundler with CSS support.

Build in the workspace with `npm run build --workspace @part/browser`.
This is a private experimental package; pin its exact version and its core dependency.
