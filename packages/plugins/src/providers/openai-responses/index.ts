import type { Model } from '@slop-lab/part/reference/index.js';
import { createResponsesDecoder } from './decode.js';
import { encodeResponses } from './encode.js';

/** Stateless HTTP Responses: text, runtime function tools and native reasoning items. */
export function createOpenAIResponsesAdapter(
  options: { chatGPTPlan?: boolean } = {},
): Model.Adapter {
  return {
    id: 'part/openai-responses',
    encode: (invocation, profile) => encodeResponses(invocation, profile, options.chatGPTPlan),
    createDecoder: (response) => createResponsesDecoder(response, options.chatGPTPlan),
  };
}
