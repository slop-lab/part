import type { Model } from '@part/core/reference';
import { createResponsesDecoder } from './decode.js';
import { encodeResponses } from './encode.js';

/** Stateless HTTP Responses: text, runtime function tools and native reasoning items. */
export function createOpenAIResponsesAdapter(): Model.Adapter {
  return {
    id: 'part/openai-responses',
    encode: encodeResponses,
    createDecoder: createResponsesDecoder,
  };
}
