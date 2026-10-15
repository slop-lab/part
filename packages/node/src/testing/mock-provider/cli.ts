#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMockProviderClient, readMockSession } from './client.js';
import { fixtureFromTranscript, readFixture, readReply } from './protocol.js';
import { startMockProvider } from './server.js';
const [command, ...argumentsList] = process.argv.slice(2);
const help = `part-mock-provider serve --mode interactive|fixed --project ID --session FILE [--fixture FILE] [--root DIR] [--scenario TEXT] [--port N] [--timeout-ms N] [--transcript FILE]
part-mock-provider pending --session FILE [--wait-ms N]
part-mock-provider inspect --session FILE --id REQUEST_ID
part-mock-provider respond --session FILE --id REQUEST_ID --decision-id ID (--text TEXT | --reply FILE)
part-mock-provider reject --session FILE --id REQUEST_ID --decision-id ID --message TEXT [--status N]
part-mock-provider fixture --session FILE --output FILE
part-mock-provider fixture --transcript FILE --output FILE
part-mock-provider status|transcript|verify|stop --session FILE [--output FILE]
`;
async function main() {
  if (!command || command === '--help' || command === 'help') {
    process.stdout.write(help);
    return;
  }
  const options = new Map<string, string>();
  const allowed = new Set([
    'mode',
    'project',
    'session',
    'fixture',
    'root',
    'scenario',
    'port',
    'timeout-ms',
    'transcript',
    'wait-ms',
    'id',
    'decision-id',
    'text',
    'reply',
    'message',
    'status',
    'output',
  ]);
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index],
      value = argumentsList[index + 1];
    if (
      !key?.startsWith('--') ||
      !allowed.has(key.slice(2)) ||
      value === undefined ||
      options.has(key.slice(2))
    )
      throw Error('Invalid or duplicate arguments; use --help');
    options.set(key.slice(2), value);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (value === undefined) throw Error(`--${key} is required`);
    return value;
  };
  const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
  const output = async (value: unknown) => {
    const text = JSON.stringify(value, null, 2) + '\n';
    if (options.has('output')) await writeFile(required('output'), text, { mode: 0o600 });
    else process.stdout.write(text);
  };
  if (command === 'serve') {
    const mode = required('mode');
    if (mode !== 'interactive' && mode !== 'fixed') throw Error('Invalid --mode');
    const provider = await startMockProvider({
      mode,
      project: {
        id: required('project'),
        root: resolve(options.get('root') ?? process.cwd()),
        ...(options.has('scenario') ? { scenario: required('scenario') } : {}),
      },
      ...(options.has('fixture') ? { fixture: readFixture(await load(required('fixture'))) } : {}),
      port: Number(options.get('port') ?? 0),
      requestTimeoutMs: Number(options.get('timeout-ms') ?? 300000),
    });
    const stop = () => {
      void provider.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await writeFile(required('session'), JSON.stringify(provider.session, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await output(provider.session);
      await provider.closed;
      if (options.has('transcript'))
        await writeFile(
          required('transcript'),
          JSON.stringify(provider.transcript(), null, 2) + '\n',
          { mode: 0o600 },
        );
      provider.verify();
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await provider.close();
    }
    return;
  }
  if (command === 'fixture' && options.has('transcript')) {
    await output(fixtureFromTranscript(await load(required('transcript'))));
    return;
  }
  const client = createMockProviderClient(readMockSession(await load(required('session'))));
  if (command === 'fixture') {
    await client.verify();
    await output(fixtureFromTranscript(await client.transcript()));
  } else if (command === 'status') await output(await client.status());
  else if (command === 'pending')
    await output(await client.pending(Number(options.get('wait-ms') ?? 0)));
  else if (command === 'inspect') await output(await client.inspect(required('id')));
  else if (command === 'respond') {
    if (options.has('text') === options.has('reply'))
      throw Error('Choose exactly one of --text or --reply');
    const reply = options.has('reply')
      ? readReply(await load(required('reply')))
      : readReply({ kind: 'completion', content: required('text') });
    await output(await client.respond(required('id'), required('decision-id'), reply));
  } else if (command === 'reject')
    await output(
      await client.respond(
        required('id'),
        options.get('decision-id') ?? randomUUID(),
        readReply({
          kind: 'error',
          status: Number(options.get('status') ?? 500),
          message: required('message'),
        }),
      ),
    );
  else if (command === 'transcript') await output(await client.transcript());
  else if (command === 'verify') {
    await client.verify();
    await output({ ok: true });
  } else if (command === 'stop') {
    await client.close();
    await output({ ok: true });
  } else throw Error(`Unknown command: ${command}`);
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Mock provider command failed');
  process.exitCode = 1;
});
