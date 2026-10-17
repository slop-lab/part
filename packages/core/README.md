# @slop-lab/part

Environment-independent contracts and execution primitives for part. No runtime
package dependencies, provider adapters, workflow engines, Node implementations or DOM UI.

```js
import { createOperations, localContext } from '@slop-lab/part';
import { createModelGateway } from '@slop-lab/part/model/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
```

Use explicit subpaths for composition, runtime, context, storage ports and clients.
`@slop-lab/part/reference/index.js` is type-only design notation, including optional contracts;
it does not claim every contract has an implementation. All built files are accessible
through their explicit package subpaths.

Build in the workspace with `npm run build --workspace @slop-lab/part`.
MIT licensed. Requires Node.js 24.22.0 or newer for Node-based usage.
APIs are experimental; pin its exact version.
