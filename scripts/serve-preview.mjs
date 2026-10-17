// @ts-check
import { startPlayground } from '../examples/playground/server.mjs';
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const port = Number(process.env.PART_PREVIEW_PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid PART_PREVIEW_PORT');
const server = await startPlayground({ port, environment: process.env });
console.log(`part playground: ${server.url}`);
console.log('Scripted examples are ready. Configured OpenAI-compatible providers are opt-in.');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
