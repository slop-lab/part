import type { Model } from '@slop-lab/part/reference/index.js';
import { createChatDecoder } from './decode.js';
import { encodeChat } from './encode.js';
/** Text/function-tool Chat Completions subset; no Responses, media or hosted tools. */
export function createOpenAICompatibleAdapter(): Model.Adapter {
  return { id: 'part/openai-compatible', encode: encodeChat, createDecoder: createChatDecoder };
}
