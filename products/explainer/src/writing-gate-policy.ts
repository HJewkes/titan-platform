import { readFileSync } from "node:fs";
import { z } from "zod";
import type { WritingStatus } from "./writing-status.js";

const SEVERITY = z.enum(["error", "warning", "report-only"]);
export type GateSeverity = z.infer<typeof SEVERITY>;

const row = <T extends z.ZodRawShape>(shape: T) => z.object({ severity: SEVERITY, evidence: z.string(), ...shape });
const capped = <T extends z.ZodRawShape>(shape: T) => row({ max: z.number().nonnegative(), ...shape });

const WritingGatePolicySchema = z.object({
  schema: z.literal("writing-gate/v1"),
  note: z.string(),
  minWords: z.number().int().positive(),
  longWords: z.number().int().positive(),
  gate: z.object({
    "short-register": row({ meanBelow: z.number().positive(), longShareBelow: z.number().min(0).max(1) }),
    "sentence-mean": row({ floor: z.number().positive() }),
    "long-share": row({ floor: z.number().min(0).max(1), minWords: z.number().int().positive() }),
    "first-person": row({}),
    "beat-length-cv": row({}),
  }),
  hallmarks: z.object({
    "naming-refrain": row({ warnAt: z.number().int().positive(), errorAt: z.number().int().positive(), maxWords: z.number().int().positive() }),
    "frame-refrain": capped({ frameWords: z.number().int().positive() }),
    "staccato-run": capped({ maxWords: z.number().int().positive(), runLength: z.number().int().min(2) }),
    "colon-tricolon": capped({}),
    teaser: capped({}),
    "parallel-recap": capped({ run: z.number().int().min(2), maxWords: z.number().int().positive() }),
    "label-first": capped({ maxWords: z.number().int().positive() }),
    "named-before-defined": capped({}),
  }),
  overrides: z.object({
    "writing-check": z.record(z.string(), z.enum(["drop", "gate", "warning", "report-only"])),
    l0: z.record(z.string(), z.literal("report-only")),
  }),
});
export type WritingGatePolicy = z.infer<typeof WritingGatePolicySchema>;

export const parseWritingGatePolicy = (text: string): WritingGatePolicy => WritingGatePolicySchema.parse(JSON.parse(text));

let policy: WritingGatePolicy | undefined;

/** `doctrine/writing-gate.json`, read once: the owner changes a row's threshold or severity there, never in code. */
export const writingGatePolicy = (): WritingGatePolicy => {
  policy ??= parseWritingGatePolicy(readFileSync(new URL("../doctrine/writing-gate.json", import.meta.url), "utf8"));
  return policy;
};

/** Replaces the shipped policy until called with undefined, so a test can pin thresholds a recalibration would move. */
export function overrideWritingGatePolicy(next: WritingGatePolicy | undefined): void {
  policy = next;
}

/**
 * A writing-check row's status after the owner's override, which sits on top of the calibrated table so a
 * recalibration of `doctrine/writing-check.json` cannot undo it.
 */
export const ownerStatus = (row: string, calibrated: WritingStatus): WritingStatus => writingGatePolicy().overrides["writing-check"][row] ?? calibrated;

/** L0 rows the owner made report-only: they keep their value and never fail. */
export const reportOnlyL0Row = (checkId: string): boolean => writingGatePolicy().overrides.l0[checkId] === "report-only";
