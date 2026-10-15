# @part/core

Environment-independent contracts and execution primitives for part. No runtime
package dependencies, provider adapters, workflow engines, Node implementations or DOM UI.

```js
import { createOperations, localContext } from '@part/core';
import { createModelGateway } from '@part/core/model';
import { createToolDispatcher } from '@part/core/tools';
```

Use explicit subpaths for composition, runtime, context, storage ports and clients.
`@part/core/reference` is type-only design notation, including optional contracts;
it does not claim every contract has an implementation. Private helpers are not exported.

Build in the workspace with `npm run build --workspace @part/core`.
This is a private experimental package; pin its exact version.
