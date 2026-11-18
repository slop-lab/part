// @ts-check
import { createOpenAIResponsesAdapter } from '@slop-lab/part-plugins/providers/openai-responses/index.js';

/** @typedef {{id: string, type: 'message', status: string, role: string, content: [{type: string, text: string, annotations: unknown[]}]}} ResponseMessage */
/** @typedef {{id: string, type: 'function_call', status: string, call_id: string, name: string, arguments: string}} ResponseCall */
/** @typedef {{id: string, type: 'reasoning', summary: {type: string, text: string}[], encrypted_content: string}} ResponseReasoning */
/** @typedef {ResponseMessage | ResponseCall | ResponseReasoning} OutputItem */
/** @typedef {{type: string} & Record<string, unknown>} ResponseEvent */
export const adapter = createOpenAIResponsesAdapter();
export const profile = {
  id: 'responses',
  revision: '1',
  adapterId: adapter.id,
  transportId: 'part/fetch',
  authStrategyId: 'none',
  model: 'fixture-model',
  endpoint: 'https://fixture.invalid/v1/responses',
  defaults: {},
  capabilities: { revision: '1', entries: [] },
};
/** @param {string} text @param {string} id @returns {ResponseMessage} */
export const message = (text, id = 'msg-1') => ({
  id,
  type: 'message',
  status: 'completed',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});
/** @type {ResponseCall} */
export const call = {
  id: 'fc-1',
  type: 'function_call',
  status: 'completed',
  call_id: 'call-1',
  name: 'uppercase',
  arguments: '{"text":"hello"}',
};
/** @type {ResponseReasoning} */
export const reasoning = {
  id: 'rs-1',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Use the tool.' }],
  encrypted_content: 'opaque-fixture',
};
/** @param {Record<string, unknown>[]} [output] */
export const completion = (output = [message('HELLO')]) => ({
  id: 'resp-1',
  object: 'response',
  status: 'completed',
  error: null,
  incomplete_details: null,
  output,
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    output_tokens_details: { reasoning_tokens: 1 },
  },
});
/** @param {string} type @param {Record<string, unknown>} fields @returns {ResponseEvent} */
export const event = (type, fields) => ({ type, ...fields });
/** @param {Record<string, unknown>[]} events @param {string} newline */
export const wire = (events, newline = '\n') =>
  events
    .map(
      (value) => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`,
    )
    .join('');

/** @param {OutputItem[]} output */
export function eventsFor(output) {
  const events = [event('response.created', { response: { id: 'resp-1', status: 'in_progress' } })];
  output.forEach((item, output_index) => {
    events.push(
      event('response.output_item.added', {
        output_index,
        item: {
          ...item,
          status: 'in_progress',
          ...(item.type === 'function_call' ? { arguments: '' } : {}),
        },
      }),
    );
    if (item.type === 'message') {
      const metadata = { output_index, item_id: item.id, content_index: 0 };
      for (const delta of item.content[0].text)
        events.push(event('response.output_text.delta', { ...metadata, delta }));
      events.push(event('response.output_text.done', { ...metadata, text: item.content[0].text }));
    }
    if (item.type === 'function_call') {
      const metadata = { output_index, item_id: item.id };
      for (const delta of item.arguments)
        events.push(event('response.function_call_arguments.delta', { ...metadata, delta }));
      events.push(
        event('response.function_call_arguments.done', { ...metadata, arguments: item.arguments }),
      );
    }
    events.push(event('response.output_item.done', { output_index, item }));
  });
  events.push(event('response.completed', { response: completion(output) }));
  return events.map((entry, sequence_number) => ({ ...entry, sequence_number }));
}
