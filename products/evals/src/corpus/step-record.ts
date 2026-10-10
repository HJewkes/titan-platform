import { z } from "zod";

/** One `workflow_run.step_results` entry. Older writers stored `output` as a JSON string, newer ones as an object, and some only as `data`. */
const StepRecordSchema = z.looseObject({
  completedAt: z.string().optional(),
  output: z.unknown().optional(),
  data: z.unknown().optional(),
});

const ResultEnvelope = z.looseObject({ result: z.unknown() });

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

interface StepPayload {
  completedAt: string | undefined;
  /** `output.result` (or `data.result`) when the step wrapped its result, else the payload itself. */
  result: unknown;
}

/** Reads a step entry whatever shape its writer used; undefined when it carries nothing readable. */
export function readStep(entry: unknown): StepPayload | undefined {
  const record = StepRecordSchema.safeParse(entry);
  if (!record.success) return undefined;
  const payload = parseJsonText(record.data.output) ?? parseJsonText(record.data.data);
  if (payload === undefined || payload === null) return undefined;
  const envelope = ResultEnvelope.safeParse(payload);
  return { completedAt: record.data.completedAt, result: envelope.success ? envelope.data.result : payload };
}

/** `sh-await-verdict:<head>:0` is family `sh-await-verdict`: the suffixes are heads, rounds and iterations. */
export const stepFamily = (key: string): string => key.split(":")[0] ?? key;

export const VerdictResultSchema = z.looseObject({
  kind: z.literal("verdict"),
  head: z.string(),
  verdict: z.enum(["MERGE", "FIX_FIRST"]),
  text: z.string().optional(),
  reviewerProfile: z.string().nullish(),
  reviewer: z.looseObject({ agentId: z.string().nullish(), sessionId: z.string().nullish() }).nullish(),
  locator: z.looseObject({ source: z.unknown() }).nullish(),
});
export type VerdictResult = z.infer<typeof VerdictResultSchema>;

export const ReviewDispatchSchema = z.looseObject({ kind: z.literal("dispatched"), head: z.string(), startedAt: z.number().optional(), at: z.number().optional() });
export const LandedSchema = z.looseObject({ headSha: z.string(), mergeSha: z.string() });
export const MainCiSchema = z.looseObject({ mergeSha: z.string(), verdict: z.string() });
export const MainRedSchema = z.looseObject({ mergeSha: z.string() });

export const RunParamsSchema = z.looseObject({ repo: z.string(), pr: z.union([z.string(), z.number()]).transform(Number) });

export const OwnerGatePayloadSchema = z.looseObject({ decision: z.string(), headSha: z.string() });
export const ResolverSchema = z.looseObject({ class: z.string() });
