import type { Model } from '@slop-lab/part/reference/index.js';
import { createMessagesDecoder } from './decode.js';
import { encodeMessages } from './encode.js';

/** Anthropic Messages text and runtime function tools over JSON or SSE. */
export function createAnthropicMessagesAdapter(): Model.Adapter {
  return {
    id: 'part/anthropic-messages',
    encode: encodeMessages,
    createDecoder: createMessagesDecoder,
  };
}
