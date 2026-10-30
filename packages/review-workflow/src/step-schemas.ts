import type { PanelPlan, PanelVerdict } from "@titan-design/review-panel";
import { z } from "zod";
import type { AwaitRecord, DispatchRecord } from "./failure.js";
import type { FixerRecord } from "./fixer.js";
import type { HealEffect } from "./heal.js";
import type { PreflightSnapshot } from "./preflight.js";
import type { ReviewOutcome } from "./types.js";

/**
 * How the recipe reads a recorded step. A host binds it to its own engine: Shepherd to `step(ctx, id, input, schema)`, the
 * standalone workflow to `codeStep`. A replay returns the recorded answer, which the schema checks.
 */
export type StepCall = <R>(stepId: string, input: object, schema: z.ZodType<R>) => Promise<R>;

/**
 * Each record is checked on its discriminant and the fields the recipe branches on; the rest is the body's own record, so
 * a field added later still replays.
 */
const recorded = <T>(shape: z.ZodRawShape): z.ZodType<T> => {
  const record = z.looseObject(shape);
  return z.custom<T>((value) => record.safeParse(value).success);
};

const MEMBER = { name: z.string(), profile: z.string(), degraded: z.boolean() };

export const DispatchRecordSchema: z.ZodType<DispatchRecord> = z.union([
  recorded<DispatchRecord>({ kind: z.literal("started"), ...MEMBER, agentId: z.string(), sessionId: z.string(), dispatchedAt: z.number(), startedAt: z.number() }),
  recorded<DispatchRecord>({ kind: z.literal("never-started"), ...MEMBER }),
  recorded<DispatchRecord>({ kind: z.literal("refused"), ...MEMBER, error: z.string(), message: z.string() }),
]);

export const AwaitRecordSchema = recorded<AwaitRecord>({ kind: z.enum(["verdict", "none", "timeout"]) });

export type CorrectRecord = { kind: "asked"; startedAt: number } | { kind: "none"; reason: string };
export const CorrectRecordSchema = recorded<CorrectRecord>({ kind: z.enum(["asked", "none"]) });

export const PreflightRecordSchema = recorded<PreflightSnapshot>({ target: z.looseObject({ head: z.string() }), head: z.looseObject({ pr: z.looseObject({}) }) });

export const HealRecordSchema = recorded<HealEffect>({ kind: z.enum(["healed", "stop", "ineffective"]) });

export const IntentRecordSchema = recorded<{ plan: PanelPlan }>({ plan: z.looseObject({ members: z.array(z.looseObject({ shape: z.string(), profile: z.string() })) }) });

export const VerdictRecordSchema = recorded<PanelVerdict>({ outcome: z.enum(["MERGE", "FIX_FIRST", "no-verdict", "timeout"]), head: z.string() });

export const FixerStepSchema = recorded<{ record: FixerRecord; outcome: ReviewOutcome }>({ record: z.looseObject({ fingerprint: z.string() }), outcome: z.looseObject({ kind: z.string() }) });
