import type { Contracts, Results, Storage } from './reference.js';
import { ok, fail, digest, canonical, freeze, isJson } from './contracts.js';
import { createOperations } from './runtime.js';
import type { Operations } from './runtime.js';
import { provenance } from './context.js';
export interface ResultsOptions {
  artifacts?: Storage.ArtifactStore;
  capture?: (
    id: string,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<{ bytes: Uint8Array; producedBy: Contracts.EntityRef }>>;
  authorizeProducer?: (
    ref: Contracts.EntityRef,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<void>>;
  processors?: readonly Results.Processor[];
  profiles?: Readonly<Record<string, readonly string[]>>;
  maxBytes?: number;
  operations?: Operations;
  processorTimeoutMs?: number;
}
export function createResults(
  types: readonly Results.TypeDefinition<unknown>[],
  options: ResultsOptions = {},
): Contracts.Result<Results.Service> {
  if (
    types.some((type) => type.id !== type.schema.ref.id || type.version !== type.schema.ref.version)
  )
    return fail('results.schema-ref', 'Result type and schema reference must agree');
  const schemas = new Map(types.map((t) => [`${t.id}@${t.version}`, t.schema]));
  const processors = new Map((options.processors ?? []).map((p) => [p.id, p]));
  const profiles = structuredClone(options.profiles ?? {});
  if (schemas.size !== types.length || processors.size !== (options.processors ?? []).length)
    return fail('results.duplicate', 'Duplicate result type or processor');
  if (
    Object.hasOwn(profiles, 'schema') ||
    Object.values(profiles).some((ids) => ids.some((id) => !processors.has(id)))
  )
    return fail('results.profile', 'Invalid validation profile');
  const records = new Map<
    string,
    { accepted: Results.Accepted; principal: Contracts.InvocationContext['principal'] }
  >();
  const submissions = new Map<
    string,
    { digest: string; result: Promise<Contracts.Result<Results.Accepted>> }
  >();
  const operations = options.operations ?? createOperations();
  const timeout = options.processorTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    return fail('results.timeout', 'Invalid processor timeout');
  const maximum = options.maxBytes ?? 16 * 1024 * 1024;
  const schemaFor = (ref: Contracts.SchemaRef) => schemas.get(`${ref.id}@${ref.version}`);
  async function decode(
    data: Results.Input,
    producer: Contracts.EntityRef,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Contracts.Json>> {
    if (data.kind === 'inline')
      return isJson(data.value)
        ? ok(structuredClone(data.value))
        : fail('results.json', 'Result must be lossless JSON');
    let bytes: Uint8Array;
    if (data.kind === 'artifact') {
      if (!options.artifacts)
        return fail('results.artifact', 'Artifact store not installed', 'unsupported');
      const loaded = await options.artifacts.read(data.ref, undefined, context);
      if (!loaded.ok) return loaded;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of loaded.value) {
        size += chunk.length;
        if (size > maximum) return fail('results.size', 'Result exceeds byte limit');
        chunks.push(chunk);
      }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      if (!options.capture)
        return fail('results.capture', 'Capture resolver not installed', 'unsupported');
      const loaded = await options.capture(data.captureId, context);
      if (!loaded.ok) return loaded;
      if (
        canonical(loaded.value.producedBy as unknown as Contracts.Json) !==
        canonical(producer as unknown as Contracts.Json)
      )
        return fail('results.producer', 'Capture producer does not match', 'permission');
      bytes = loaded.value.bytes.slice();
    }
    if (bytes.length > maximum || (await digest(bytes)) !== data.expectedDigest)
      return fail('results.digest', 'Result bytes changed or exceed the limit', 'conflict');
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return isJson(value) ? ok(value) : fail('results.json', 'Invalid JSON');
    } catch {
      return fail('results.json', 'Expected exactly one UTF-8 JSON value');
    }
  }
  async function submit(
    input: Results.Submission,
    context: Contracts.InvocationContext,
  ): Promise<Contracts.Result<Results.Accepted>> {
    if (context.signal.aborted)
      return fail('results.cancelled', 'Submission cancelled', 'cancelled');
    if (options.authorizeProducer) {
      const allowed = await options.authorizeProducer(input.producedBy, context);
      if (!allowed.ok) return allowed;
    }
    const chain =
      input.validationProfile === 'schema'
        ? []
        : Object.hasOwn(profiles, input.validationProfile)
          ? profiles[input.validationProfile]!
          : undefined;
    if (!chain) return fail('results.profile', 'Unknown validation profile', 'unsupported');
    const expected = schemaFor(input.expectedType);
    if (!expected) return fail('results.type', 'Result schema not installed', 'unsupported');
    let data = input.data;
    const validation: Results.Validation[] = [];
    async function check(
      data: Results.Input,
      ref: Contracts.SchemaRef,
    ): Promise<Contracts.Result<Contracts.Json>> {
      const schema = schemaFor(ref);
      if (!schema) return fail('results.type', 'Processor schema not installed', 'unsupported');
      const decoded = await decode(data, input.producedBy, context);
      if (!decoded.ok) return decoded;
      const checked = schema.validate(decoded.value);
      if (!checked.ok) return fail('results.validation', 'Result schema validation failed');
      const wire = schema.codec?.encode(checked.value);
      return wire?.ok ? wire : fail('results.codec', 'Result requires a lossless codec');
    }
    for (const id of chain) {
      const processor = processors.get(id)!;
      const checked = await check(data, processor.inputType);
      if (!checked.ok) return checked;
      const before = await digest(checked.value);
      if (context.signal.aborted)
        return fail('results.cancelled', 'Processing cancelled', 'cancelled');
      // Pass a fixed explicit capture; processors never re-read mutable source files.
      const invocation = await operations.begin<{
        output: Results.Input;
        evidence: Results.Validation;
      }>(
        { kind: 'part/result-processor', childPolicy: 'attached', retryOwner: 'part/results' },
        async (c) => {
          const processed = await processor.process(
            freeze({ kind: 'inline', value: checked.value }),
            c,
          );
          return processed.ok
            ? {
                phase: 'completed',
                result: processed.value,
                effect: 'not-applicable',
                commit: [],
                unsettledChildren: [],
              }
            : {
                phase: 'failed',
                error: processed.error,
                effect: processed.error.effect ?? 'not-applicable',
                commit: [],
                unsettledChildren: [],
              };
        },
        {
          ...context,
          deadline: new Date(
            Math.min(
              context.deadline ? Date.parse(context.deadline) : Infinity,
              Date.now() + timeout,
            ),
          ).toISOString(),
        },
      );
      if (!invocation.ok) return invocation;
      const completed = await invocation.value.done;
      if (completed.phase !== 'completed')
        return fail(
          'results.processor',
          'Processor failed, timed out, or did not confirm cancellation',
          completed.phase === 'cancelled' ? 'cancelled' : 'internal',
          completed.effect,
        );
      const processed = ok(completed.result);
      if (!processed.ok) return processed;
      const output = await check(processed.value.output, processor.outputType);
      if (!output.ok) return output;
      const after = await digest(output.value),
        evidence = processed.value.evidence;
      if (
        !isJson(evidence) ||
        evidence.validator !== processor.id ||
        evidence.version !== processor.version ||
        evidence.status !== 'pass' ||
        evidence.inputDigest !== before ||
        evidence.outputDigest !== after
      )
        return fail('results.evidence', 'Processor evidence does not match the validated bytes');
      validation.push(structuredClone(evidence));
      data = { kind: 'inline', value: output.value };
    }
    const checked = await check(data, input.expectedType);
    if (!checked.ok) return checked;
    if (context.signal.aborted)
      return fail('results.cancelled', 'Submission cancelled', 'cancelled');
    const hash = await digest(checked.value);
    validation.push({
      validator: expected.ref.id,
      version: String(expected.ref.version),
      inputDigest: hash,
      status: 'pass',
      diagnostics: [],
    });
    const accepted: Results.Accepted = freeze({
      id: crypto.randomUUID(),
      type: { ...input.expectedType },
      data: { kind: 'inline', value: checked.value },
      digest: hash,
      producedBy: { ...input.producedBy },
      validation,
      provenance,
      commit: [],
    });
    records.set(accepted.id, { accepted, principal: { ...context.principal } });
    return ok(accepted);
  }
  return ok({
    async submit(input, context) {
      if (!isJson(input)) return fail('results.input', 'Submission must be lossless JSON');
      input = structuredClone(input);
      const key = canonical({ principal: context.principal, submissionId: input.submissionId }),
        fingerprint = canonical(input as unknown as Contracts.Json);
      const existing = submissions.get(key);
      if (existing)
        return existing.digest === fingerprint
          ? existing.result
          : fail('results.submission', 'Submission ID has different content', 'conflict');
      const result = Promise.resolve()
        .then(() => submit(input, context))
        .catch(() => fail('results.processor', 'Result processing failed', 'internal'));
      submissions.set(key, { digest: fingerprint, result });
      return result;
    },
    async read(id, context) {
      const record = records.get(id);
      if (!record) return fail('results.missing', 'Result not found');
      return canonical(record.principal) === canonical(context.principal)
        ? ok(record.accepted)
        : fail('results.permission', 'Result access denied', 'permission');
    },
  });
}
