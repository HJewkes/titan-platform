import { z, type ZodType } from "zod";
import { ConfirmRowSchema } from "../judge/index.js";
import { QuerySpecSchema, type Passage } from "../types.js";
import type { Answer, Coverage, SourcedRow } from "./answer.js";
import type { CompileRecord } from "./compile.js";
import type { Models } from "./routes.js";
import type { BatchArtifact, CostEntry, UsageEntry } from "./run-dir.js";

/** Schemas for what a run reads back from disk or the record, so a resumed run never trusts a stale or foreign file. */

const StepUsageSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWrite5mTokens: z.number().optional(),
  cacheWrite1hTokens: z.number().optional(),
  costUnknown: z.literal(true).optional(),
});

const UsageEntrySchema: ZodType<UsageEntry> = z.object({ stepId: z.string(), model: z.string(), usage: StepUsageSchema });

const VoidedSchema = z.object({ id: z.string(), reason: z.enum(["unknown-id", "quote-too-long", "quote-not-in-passage", "quote-unverifiable"]) });

export function batchArtifactSchema<T>(item: ZodType<T>): ZodType<BatchArtifact<T>> {
  return z.object({
    key: z.string(),
    stage: z.enum(["screen", "confirm"]),
    round: z.number().optional(),
    book: z.string().optional(),
    via: z.enum(["primary", "redo", "unjudged"]),
    passageIds: z.array(z.string()),
    items: z.array(item),
    voided: z.array(VoidedSchema),
    unjudged: z.array(z.string()),
    flagged: z.boolean(),
    canaryMisses: z.number(),
    reason: z.string().optional(),
    usage: z.array(UsageEntrySchema),
  });
}

export const CompileRecordSchema: ZodType<CompileRecord> = z.object({ spec: QuerySpecSchema, usage: z.array(UsageEntrySchema) });

export const CostEntrySchema: ZodType<CostEntry> = StepUsageSchema.omit({ costUsd: true, costUnknown: true }).extend({
  stage: z.enum(["compile", "screen", "confirm"]),
  model: z.string(),
  cliCostUsd: z.number(),
});

export const PassagesSchema: ZodType<Passage[]> = z.array(
  z.object({ id: z.string(), chapterId: z.string(), ref: z.string(), firstParagraph: z.number(), lastParagraph: z.number(), fileSha8: z.string() }),
);

export const CollectSchema = z.object({ expected: z.number(), missing: z.array(z.string()) });

export const ModelsSchema: ZodType<Models> = z.object({ compile: z.string(), screen: z.string(), confirm: z.string(), redo: z.string() });

const CoverageSchema: ZodType<Coverage> = z.object({
  retrieved: z.number(),
  judged: z.number(),
  voided: z.number(),
  unjudged: z.array(z.string()),
  skipped: z.array(z.string()),
  canaries: z.object({ batches: z.number(), misses: z.number() }),
});

const SourcedRowSchema: ZodType<SourcedRow> = ConfirmRowSchema.extend({ ref: z.string(), book: z.string(), order: z.array(z.union([z.number(), z.string()])) });

export const AnswerSchema: ZodType<Answer> = z.object({
  runId: z.string(),
  rounds: z.number(),
  candidates: z.number(),
  rows: z.array(SourcedRowSchema),
  coverage: z.object({ screen: CoverageSchema, confirm: CoverageSchema }),
});
