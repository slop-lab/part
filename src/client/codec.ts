import { fail, isJson, ok } from '../contracts/index.js';
import type { Client } from '../reference/client.js';
export const jsonCodec: Client.Codec = {
  encode(value) {
    return isJson(value)
      ? ok(new TextEncoder().encode(JSON.stringify(value)))
      : fail('wire.encode', 'Value is not lossless JSON');
  },
  decode(bytes) {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return isJson(value) ? ok(value) : fail('wire.decode', 'Invalid JSON');
    } catch {
      return fail('wire.decode', 'Malformed UTF-8 JSON');
    }
  },
};
