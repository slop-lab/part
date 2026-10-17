// @ts-check
import { fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';

/** Host-selected command, never a model claim that tests passed.
 * @param {{argv: readonly string[], tools: readonly import('@slop-lab/part/reference/index.js').Tools.InstalledTool[],
 * boundary: import('@slop-lab/part/reference/index.js').Runtime.InvocationBoundary}} options
 * @returns {import('@slop-lab/part-plugins/swe/coding.js').CodingDriverOptions['validate']}
 */
export function createCompletionCheck(options) {
  const command = options.argv[0];
  if (!command) throw new TypeError('Completion command requires an executable');
  const dispatcher = createToolDispatcher({ tools: options.tools, boundary: options.boundary });
  if (!dispatcher.ok) throw new Error(dispatcher.error.message);
  return async (_response, context) => {
    const started = await dispatcher.value.dispatch(
      {
        logicalCallId: crypto.randomUUID(),
        toolId: 'swe_exec',
        arguments: { command, args: options.argv.slice(1), timeoutMs: 120_000 },
      },
      context,
    );
    if (!started.ok) return started;
    const outcome = await started.value.done;
    if (outcome.phase !== 'completed')
      return fail(
        'car.check',
        'Completion command did not finish successfully',
        'validation',
        outcome.effect,
      );
    const value = outcome.result.value;
    return ok({
      summary: 'Host-selected completion command',
      checks: [
        {
          id: 'command-exit',
          passed: isJsonObject(value) && value.success === true && value.truncated === false,
          detail: isJsonObject(value)
            ? `exit ${value.exitCode}; status ${value.status}`
            : 'Missing process evidence',
        },
      ],
    });
  };
}
