#!/usr/bin/env node
// @ts-check
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localContext } from '@slop-lab/part/contracts/index.js';
import {
  startMockProvider,
  createMockProviderClient,
  readMockSession,
} from '@slop-lab/part-node/testing/mock-provider/index.js';
import { createCarModel } from './model.mjs';
import { connectLocalToolsetCheckout } from './infrastructure.mjs';
import { openCar } from './runtime.mjs';
import { startCarServer } from './server.mjs';
import { recoverStateLock } from './state.mjs';
import { cleanupStages } from './cleanup.mjs';

const help = `CAR: part's software engineering subproject

node car/src/cli.mjs serve --root PATH --state PATH [options]
node car/src/cli.mjs recover-lock --state PATH

  --port NUMBER             Browser/API port (default: ephemeral)
  --host ADDRESS            Bind address (default: 127.0.0.1)
  --provider interactive|chat|responses  Default: interactive, no paid model
  --base-url URL            Router4u/compatible URL, or R4U_BASE_URL
  --model NAME              Model name, or R4U_MODEL
  --route NAME              Optional Router4u route, or R4U_ROUTE
  --edit-mode hash|exact    Select local file edit ACI
  --trace metadata|full     Full explicitly stores model input/request bodies
  --mock-session PATH       Write interactive session exclusively, mode 0600
  --operator-session PATH   Give subagents tools to answer a separate target mock
  --toolset-checkout PATH   Connect existing checkout/dist/mcp.js over MCP
  --tools ID,ID             Explicit remote tool allowlist
  --toolset-profile p0|p1   Optional server tool profile
  --workspace-provider local|external  Select workspace tools (default local)
  --workflows true          Enable pinned .agents/workflows/*.pipeline.json
  --check JSON_ARGV         Completion test command (host alias or absolute executable)

Set CAR_TOKEN for a stable API token (at least 16 characters).
Set R4U_API_KEY for chat/responses. Secrets stay server-side.
DIM is never started or contacted. Stop with SIGINT/SIGTERM.
`;

/** @param {readonly string[]} argv */
function parse(argv) {
  const known = new Set([
    'root',
    'state',
    'port',
    'host',
    'provider',
    'base-url',
    'model',
    'route',
    'edit-mode',
    'trace',
    'mock-session',
    'operator-session',
    'toolset-checkout',
    'toolset-profile',
    'tools',
    'workspace-provider',
    'workflows',
    'check',
  ]);
  /** @type {Record<string,string>} */
  const result = {};
  if (argv[0] !== 'serve') throw new TypeError('Expected serve; use --help');
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (
      !name ||
      !known.has(name) ||
      value === undefined ||
      value.startsWith('--') ||
      name in result
    )
      throw new TypeError('Unknown, duplicate, or incomplete option; use --help');
    result[name] = value;
  }
  if (!result.root || !result.state) throw new TypeError('--root and --state are required');
  return result;
}

/** @param {readonly string[]} argv */
export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(help);
    return;
  }
  if (argv[0] === 'recover-lock') {
    if (argv.length !== 3 || argv[1] !== '--state' || !argv[2])
      throw new TypeError('recover-lock requires --state PATH');
    console.log(JSON.stringify(await recoverStateLock(argv[2])));
    return;
  }
  const args = parse(argv);
  const provider = args.provider ?? 'interactive';
  if (provider !== 'interactive' && provider !== 'chat' && provider !== 'responses')
    throw new TypeError('Unsupported provider');
  const editMode = args['edit-mode'] ?? 'hash';
  if (editMode !== 'hash' && editMode !== 'exact') throw new TypeError('Unsupported edit mode');
  const trace = args.trace ?? 'metadata';
  if (trace !== 'full' && trace !== 'metadata') throw new TypeError('Unsupported trace policy');
  const workspaceProvider = args['workspace-provider'] ?? 'local';
  if (workspaceProvider !== 'local' && workspaceProvider !== 'external')
    throw new TypeError('Unsupported workspace provider');
  const port = Number(args.port ?? 0);
  const toolsetProfile = args['toolset-profile'] ?? 'p0';
  if (toolsetProfile !== 'p0' && toolsetProfile !== 'p1')
    throw new TypeError('Unsupported toolset profile');
  if (args.workflows !== undefined && args.workflows !== 'true')
    throw new TypeError('--workflows requires true');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  const root = resolve(args.root ?? '');
  /** @type {unknown} */
  const check = args.check === undefined ? undefined : JSON.parse(args.check);
  if (
    check !== undefined &&
    (!Array.isArray(check) || !check.length || check.some((part) => typeof part !== 'string'))
  )
    throw new TypeError('--check must be a non-empty JSON argv array');
  const context = localContext({ principal: { subject: 'developer', authority: 'car/local' } });
  const token = process.env.CAR_TOKEN ?? crypto.randomUUID();
  /** @type {Awaited<ReturnType<typeof startMockProvider>> | undefined} */
  let mock;
  /** @type {Awaited<ReturnType<typeof connectLocalToolsetCheckout>> | undefined} */
  let external;
  /** @type {Awaited<ReturnType<typeof openCar>> | undefined} */
  let car;
  /** @type {Awaited<ReturnType<typeof startCarServer>> | undefined} */
  let server;
  try {
    if (provider === 'interactive') {
      mock = await startMockProvider({ mode: 'interactive', project: { id: 'car', root } });
      if (args['mock-session'])
        await writeFile(args['mock-session'], JSON.stringify(mock.session), {
          flag: 'wx',
          mode: 0o600,
        });
    }
    const model = createCarModel({
      baseURL: mock?.session.baseURL ?? args['base-url'] ?? process.env.R4U_BASE_URL ?? '',
      apiKey: mock?.session.apiKey ?? process.env.R4U_API_KEY ?? '',
      model: args.model ?? process.env.R4U_MODEL ?? 'car-test',
      protocol: provider === 'responses' ? 'responses' : 'chat',
      ...((args.route ?? process.env.R4U_ROUTE)
        ? { route: args.route ?? process.env.R4U_ROUTE }
        : {}),
    });
    if (args['toolset-checkout']) {
      const state = resolve(args.state ?? '');
      await mkdir(state, { recursive: true, mode: 0o700 });
      external = await connectLocalToolsetCheckout({
        root,
        checkout: resolve(args['toolset-checkout']),
        allowedTools: (args.tools ?? '').split(',').filter(Boolean),
        profile: toolsetProfile,
        statePath: resolve(state, 'toolset.sqlite'),
      });
    }
    if (workspaceProvider === 'external' && !external)
      throw new TypeError('External workspace tools require --toolset-checkout');
    const operator = args['operator-session']
      ? createMockProviderClient(
          readMockSession(JSON.parse(await readFile(args['operator-session'], 'utf8'))),
        )
      : undefined;
    car = await openCar({
      root,
      stateDirectory: resolve(args.state ?? ''),
      model,
      context,
      editMode,
      trace,
      workspaceProvider,
      workflows: args.workflows === 'true',
      ...(Array.isArray(check) ? { completionCommand: check } : {}),
      ...(external ? { external } : {}),
      ...(operator ? { operator } : {}),
    });
    server = await startCarServer(car, { token, context, port, host: args.host ?? '127.0.0.1' });
    console.log(
      JSON.stringify({
        product: 'car',
        url: server.url,
        token,
        root,
        ...(mock ? { mockSession: mock.session } : {}),
        dim: 'disabled',
      }),
    );
    await new Promise((done) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        done(undefined);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    const report = await cleanupStages([
      { name: 'http', close: () => server?.close() },
      { name: 'car', close: () => car?.close() },
      { name: 'external-tools', close: () => external?.close() },
      { name: 'mock-provider', close: () => mock?.close() },
    ]);
    if (report.errors.length || report.unresolved.length) {
      console.error(JSON.stringify({ cleanup: report }));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'CAR failed');
    process.exitCode = 1;
  });
}
