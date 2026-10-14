# part

Progressive agent runtime: a small embedded execution foundation with optional
model, tool, context, persistence, client, and workflow layers.

This repository is under active implementation. **G-BASE has not passed.**
Dependent products should not yet pin this as their integration foundation.
See [architecture decisions](docs/architecture.md) and [gate status](docs/gates.md).

```sh
npm ci
npm test
npm run example
```

All runtime plugins execute as trusted in-process code. Capability declarations
are not isolation. The reference contracts describe the target design; implemented
exports and tested guarantees are recorded separately.
