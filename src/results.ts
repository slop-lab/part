import type { Contracts as C, Results as R } from './reference.js';
import { ok, fail, digest, canonical, freeze } from './contracts.js';
import { provenance } from './context.js';
export function createResults(types: readonly R.TypeDefinition<unknown>[]): C.Result<R.Service> {
  const schemas = new Map(types.map(t => [`${t.id}@${t.version}`, t.schema]));
  if (schemas.size !== types.length) return fail('results.duplicate', 'Duplicate result type');
  const records = new Map<string, { accepted: R.Accepted; principal: C.InvocationContext['principal'] }>(), submissions = new Map<string, { digest: string; accepted: R.Accepted }>();
  return ok({ async submit(input, context) {
    if (context.signal.aborted) return fail('results.cancelled', 'Submission cancelled', 'cancelled');
    if (input.data.kind !== 'inline') return fail('results.capture', 'Only explicit inline captures are installed', 'unsupported');
    if (input.validationProfile !== 'schema') return fail('results.profile', 'Unknown validation profile', 'unsupported');
    const schema = schemas.get(`${input.expectedType.id}@${input.expectedType.version}`); if (!schema) return fail('results.type', 'Result schema not installed', 'unsupported');
    const checked = schema.validate(input.data.value); if (!checked.ok) return fail('results.validation', 'Result schema validation failed');
    const wire = schema.codec?.encode(checked.value); if (!wire?.ok) return fail('results.codec', 'Result requires a lossless codec');
    const key = canonical({ principal: context.principal, submissionId: input.submissionId }), inputDigest = await digest(input as unknown as C.Json);
    const existing = submissions.get(key); if (existing) return existing.digest === inputDigest ? ok(existing.accepted) : fail('results.submission', 'Submission ID has different content', 'conflict');
    const hash = await digest(wire.value), accepted: R.Accepted = freeze({ id: crypto.randomUUID(), type: { ...input.expectedType }, data: { kind: 'inline', value: structuredClone(wire.value) }, digest: hash,
      producedBy: { ...input.producedBy }, validation: [{ validator: schema.ref.id, version: String(schema.ref.version), inputDigest: hash, status: 'pass', diagnostics: [] }], provenance, commit: [] });
    records.set(accepted.id, { accepted, principal: { ...context.principal } }); submissions.set(key, { digest: inputDigest, accepted }); return ok(accepted);
  }, async read(id, context) {
    const record = records.get(id); if (!record) return fail('results.missing', 'Result not found');
    if (record.principal.subject !== context.principal.subject || record.principal.authority !== context.principal.authority) return fail('results.permission', 'Result access denied', 'permission');
    return ok(record.accepted);
  } });
}
