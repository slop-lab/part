export const processRunnerSource = String.raw`
const { spawn } = require('node:child_process');
const { closeSync, openSync, writeFileSync, writeSync } = require('node:fs');

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const stdout = openSync(config.stdoutPath, 'w');
const stderr = openSync(config.stderrPath, 'w');
let bytes = 0;
let truncated = false;
let finished = false;
const capture = (fd, chunk) => {
  const remaining = Math.max(0, config.maxOutputBytes - bytes);
  if (remaining > 0) {
    const selected = chunk.subarray(0, remaining);
    writeSync(fd, selected);
    bytes += selected.length;
  }
  if (chunk.length > remaining) truncated = true;
};
const finish = (value, code) => {
  if (finished) return;
  finished = true;
  closeSync(stdout);
  closeSync(stderr);
  writeFileSync(config.metaPath, JSON.stringify({ ...value, truncated, bytes }));
  process.exitCode = code;
};

let child;
try {
  child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.environment,
    shell: config.shell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  finish({ exitCode: null, signal: null, error: String(error) }, 1);
  return;
}
child.stdout.on('data', (chunk) => capture(stdout, chunk));
child.stderr.on('data', (chunk) => capture(stderr, chunk));
child.once('error', (error) => finish({ exitCode: null, signal: null, error: String(error) }, 1));
child.once('close', (exitCode, signal) => finish({ exitCode, signal }, 0));
`;
