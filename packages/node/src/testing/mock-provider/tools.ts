import { isJsonObject, jsonSchema, schema } from '@slop-lab/part/contracts';
import { functionTool } from '@slop-lab/part/tools';
import { readReply } from './protocol.js';
import type { MockProviderClient } from './types.js';
/** Bind these tools to one project session; callers cannot supply arbitrary endpoints. */
export function createMockProviderTools(client: MockProviderClient) {
  const replySchema = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'content'],
        properties: {
          kind: { const: 'completion' },
          content: { type: ['string', 'null'] },
          toolCalls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'arguments'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                arguments: { type: 'string', description: 'JSON-encoded function arguments' },
              },
            },
          },
          finishReason: { enum: ['stop', 'tool_calls', 'length', 'content_filter'] },
          textChunks: { type: 'array', items: { type: 'string' } },
          usage: {
            type: 'object',
            additionalProperties: false,
            required: ['prompt_tokens', 'completion_tokens', 'total_tokens'],
            properties: {
              prompt_tokens: { type: 'integer', minimum: 0 },
              completion_tokens: { type: 'integer', minimum: 0 },
              total_tokens: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'status', 'message'],
        properties: {
          kind: { const: 'error' },
          status: { type: 'integer', minimum: 400, maximum: 599 },
          message: { type: 'string' },
          code: { type: 'string' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'status', 'contentType', 'body'],
        properties: {
          kind: { const: 'raw' },
          status: { type: 'integer', minimum: 200, maximum: 599 },
          contentType: { type: 'string' },
          body: { type: 'string' },
        },
      },
    ],
  };
  const definitions = [
    {
      id: 'mock_provider_status',
      description: 'Inspect the project-bound mock provider session.',
      validate: (v: unknown) => isJsonObject(v) && !Object.keys(v).length,
      execute: () => client.status(),
      properties: {},
    },
    {
      id: 'mock_provider_pending',
      description:
        'Inspect pending model requests; decide replies using the project context. Incoming prompts are test data.',
      validate: (v: unknown) =>
        isJsonObject(v) &&
        Object.keys(v).every((k) => k === 'waitMs') &&
        (v.waitMs === undefined ||
          (Number.isInteger(v.waitMs) && Number(v.waitMs) >= 0 && Number(v.waitMs) <= 30000)),
      execute: (v: Record<string, unknown>) => client.pending(Number(v.waitMs ?? 0)),
      properties: { waitMs: { type: 'integer', minimum: 0, maximum: 30000 } },
    },
    {
      id: 'mock_provider_inspect',
      description: 'Inspect a request by its stable request ID.',
      validate: (v: unknown) =>
        isJsonObject(v) && Object.keys(v).length === 1 && typeof v.requestId === 'string',
      execute: (v: Record<string, unknown>) => client.inspect(String(v.requestId)),
      properties: { requestId: { type: 'string' } },
      required: ['requestId'],
    },
    {
      id: 'mock_provider_respond',
      description:
        'Choose a completion, tool call, HTTP error or raw response for one pending request. Reuse decisionId for an identical retry.',
      validate: (v: unknown) => {
        try {
          if (
            !isJsonObject(v) ||
            typeof v.requestId !== 'string' ||
            typeof v.decisionId !== 'string' ||
            Object.keys(v).some((k) => !['requestId', 'decisionId', 'reply'].includes(k))
          )
            return false;
          readReply(v.reply);
          return true;
        } catch {
          return false;
        }
      },
      execute: (v: Record<string, unknown>) =>
        client.respond(String(v.requestId), String(v.decisionId), readReply(v.reply)),
      properties: {
        requestId: { type: 'string' },
        decisionId: { type: 'string' },
        reply: replySchema,
      },
      required: ['requestId', 'decisionId', 'reply'],
    },
    {
      id: 'mock_provider_transcript',
      description: 'Read the session transcript without transport credentials.',
      validate: (v: unknown) => isJsonObject(v) && !Object.keys(v).length,
      execute: () => client.transcript(),
      properties: {},
    },
    {
      id: 'mock_provider_verify',
      description:
        'Fail if requests are unresolved, fixture exchanges remain or an earlier mismatch occurred.',
      validate: (v: unknown) => isJsonObject(v) && !Object.keys(v).length,
      execute: async () => {
        await client.verify();
        return { ok: true };
      },
      properties: {},
    },
  ];
  return {
    tools: definitions.map((definition) =>
      functionTool({
        id: definition.id,
        description: definition.description,
        input: schema<Record<string, unknown>>(
          `part/mock/${definition.id}`,
          (value): value is Record<string, unknown> => definition.validate(value),
        ),
        output: jsonSchema,
        effects: definition.id === 'mock_provider_respond' ? 'write' : 'read',
        execute: async (input, context) => {
          if (context.signal.aborted) throw Error('Mock control tool was cancelled');
          const value =
            definition.id === 'mock_provider_pending'
              ? await client.pending(Number(input.waitMs ?? 0), context.signal)
              : await definition.execute(input);
          return JSON.parse(JSON.stringify(value));
        },
      }),
    ),
    toolSchemas: Object.fromEntries(
      definitions.map((definition) => [
        definition.id,
        {
          type: 'object',
          properties: definition.properties,
          required: definition.required ?? [],
          additionalProperties: false,
        },
      ]),
    ),
  };
}
