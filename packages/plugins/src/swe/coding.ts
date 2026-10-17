import { fail, isJsonObject, ok, schema } from '@slop-lab/part/contracts/index.js';
import type { Context, Contracts, Driver, Model } from '@slop-lab/part/reference/index.js';
import {
  createBasicDriver,
  createValidatingDriver,
  type BasicInput,
  modelResponseSchema,
} from '../agent/drivers/basic.js';

export interface CompletionCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface CompletionReport {
  readonly summary: string;
  readonly checks: readonly CompletionCheck[];
}

export interface CodingDriverOptions {
  readonly profileId: string;
  readonly tools?: readonly Model.ToolAdvertisement[];
  readonly modelCapabilities?: Contracts.CapabilitySet;
  readonly maxTurns?: number;
  readonly inspectContext?: (context: Context.CompiledContext) => void;
  readonly validate?: (
    response: Model.Response,
    context: Contracts.InvocationContext,
  ) => Promise<Contracts.Result<CompletionReport>>;
}

export const completionReportSchema = schema<CompletionReport>(
  'part/swe-completion-report',
  (value): value is CompletionReport =>
    isJsonObject(value) &&
    typeof value.summary === 'string' &&
    Array.isArray(value.checks) &&
    value.checks.length > 0 &&
    value.checks.every(
      (check) =>
        isJsonObject(check) &&
        typeof check.id === 'string' &&
        check.id.length > 0 &&
        typeof check.passed === 'boolean' &&
        (check.detail === undefined || typeof check.detail === 'string'),
    ),
);

export function createCodingDriver(
  options: CodingDriverOptions,
): Driver.Factory<BasicInput, Model.Response> {
  const base = createBasicDriver({
    profileId: options.profileId,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.modelCapabilities ? { modelCapabilities: options.modelCapabilities } : {}),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
    ...(options.inspectContext ? { inspectContext: options.inspectContext } : {}),
  });
  const validate = options.validate;
  if (!validate) return base;
  return createValidatingDriver(base, modelResponseSchema, async (response, context) => {
    const validated = await validate(response, context);
    if (!validated.ok) return validated;
    const report = completionReportSchema.validate(validated.value);
    if (!report.ok || report.value.checks.some((check) => !check.passed))
      return fail('swe.completion', 'Coding completion checks did not pass', 'validation');
    return ok(response);
  });
}
