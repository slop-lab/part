# @slop-lab/part

Environment-independent contracts and execution primitives for part. No runtime
package dependencies, provider adapters, workflow engines, Node implementations or DOM UI.

```js
import { createOperations, localContext } from '@slop-lab/part';
import { createModelGateway } from '@slop-lab/part/model';
import { createToolDispatcher } from '@slop-lab/part/tools';
```

Use explicit subpaths for composition, runtime, context, storage ports and clients.
`@slop-lab/part/reference` is type-only design notation, including optional contracts;
it does not claim every contract has an implementation. Private helpers are not exported.

Build in the workspace with `npm run build --workspace @slop-lab/part`.
This is a private experimental package; pin its exact version.
