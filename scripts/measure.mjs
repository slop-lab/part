import { performance } from 'node:perf_hooks';
const before = process.getActiveResourcesInfo(),
  memory = process.memoryUsage().heapUsed,
  start = performance.now();
await import('part');
const elapsed = performance.now() - start,
  after = process.getActiveResourcesInfo();
const activeDelta = after.filter(
  (value, index) =>
    after.slice(0, index + 1).filter((v) => v === value).length >
    before.filter((v) => v === value).length,
);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      coreImportMs: elapsed,
      heapDeltaBytes: process.memoryUsage().heapUsed - memory,
      newActiveResources: activeDelta,
      runtimeDependencies: 0,
    },
    null,
    2,
  ),
);
if (activeDelta.length) process.exitCode = 1;
