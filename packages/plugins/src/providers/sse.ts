import { fail, ok } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Model } from '@slop-lab/part/reference/index.js';

export function createSseReader(
  provider: string,
  consume: (
    data: string,
    names: readonly string[],
  ) => Contracts.Result<readonly Model.ProviderEvent[]>,
) {
  let buffer = '';
  let lines: string[] = [];
  return (text: string, flush = false): Contracts.Result<readonly Model.ProviderEvent[]> => {
    buffer += text;
    const events: Model.ProviderEvent[] = [];
    while (buffer.length) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!flush && index === buffer.length - 1 && buffer[index] === '\r')) break;
      const line = buffer.slice(0, index);
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(index + width);
      if (line) {
        lines.push(line);
        continue;
      }
      const data = lines
        .filter((entry) => entry.startsWith('data:'))
        .map((entry) => entry.slice(5).replace(/^ /, ''))
        .join('\n');
      const names = lines
        .filter((entry) => entry.startsWith('event:'))
        .map((entry) => entry.slice(6).trim());
      lines = [];
      if (!data) continue;
      const result = consume(data, names);
      if (!result.ok) return result;
      events.push(...result.value);
    }
    if (flush && (buffer.trim() || lines.some((line) => line.startsWith('data:'))))
      return fail(`${provider}.frame`, 'Incomplete SSE frame');
    return ok(events);
  };
}
