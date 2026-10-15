import assert from 'node:assert/strict';
import { createChat } from '@slop-lab/part-browser/dom';
import { createController, createWatchHub } from '@slop-lab/part/client';
assert.equal(typeof createChat, 'function');
assert.equal(typeof createController, 'function');
const hub = createWatchHub({ revision: 'consumer', entries: [] });
assert.deepEqual(hub.snapshot().items, []);
hub.close();
console.log('browser-only consumer passed');
