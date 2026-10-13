import { EXIT } from "@titan-design/registry";
import {
  LIST_PRICE_CAVEAT,
  REVIEW_FILL_COMPARISON,
  SUCCESSOR_REWORK_COMPARISON,
  compareWindows,
  renderReviewFillText,
  renderSuccessorReworkText,
  renderWindowComparisonText,
  reviewFillReport,
  reviewFillSchema,
  successorReworkReport,
  successorReworkSchema,
} from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z, type ZodType } from "zod";
import { defineInsight, isoTime, refuseSessionScope, utc } from "./define.js";

const REVIEW_FILL_COLUMNS = ["verdicts", "changesRate", "errorRate"] as const;
const SUCCESSOR_REWORK_COLUMNS = ["pairs", "meanRereads", "rereadShare", "rereadCostUsd"] as const;

type Window = { since: string | null; until: string | null };

function comparisonSchema<Report, Row>(report: ZodType<Report>, row: ZodType<Row>) {
  const pair = z.object({ key: z.string(), before: row.nullable(), after: row.nullable(), delta: z.record(z.string(), z.number().nullable()) });
  return z.object({ before: report, after: report, rows: z.array(pair) });
}

export const qualityGuardrailsSchema = z.object({
  reviewFill: reviewFillSchema,
  successorRework: successorReworkSchema,
  /** Null unless a before window was given; each delta is after minus before. */
  comparison: z
    .object({
      reviewFill: comparisonSchema(reviewFillSchema, reviewFillSchema.shape.rows.element),
      successorRework: comparisonSchema(successorReworkSchema, successorReworkSchema.shape.rows.element),
    })
    .nullable(),
});

export type QualityGuardrailsReport = z.infer<typeof qualityGuardrailsSchema>;

interface QualityGuardrailsOptions {
  beforeSince?: string;
  beforeUntil?: string;
  bootRequests?: number;
}

/** A before window with one open bound would silently compare against all history, so both bounds are required together. */
function beforeWindow(options: QualityGuardrailsOptions): Window | null {
  const { beforeSince, beforeUntil } = options;
  if (beforeSince === undefined && beforeUntil === undefined) return null;
  if (beforeSince === undefined || beforeUntil === undefined) {
    throw Object.assign(new Error("quality-guardrails needs both --before-since and --before-until, or neither"), { code: EXIT.USAGE });
  }
  return { since: utc(beforeSince)!, until: utc(beforeUntil)! };
}

function guardrails(db: Db, after: Window, before: Window | null, bootRequests: number | undefined): QualityGuardrailsReport {
  const rework = (window: Window) => successorReworkReport(db, window, { bootRequests });
  const fill = (window: Window) => reviewFillReport(db, window);
  const comparison = before && {
    reviewFill: compareWindows(fill, before, after, REVIEW_FILL_COMPARISON),
    successorRework: compareWindows(rework, before, after, SUCCESSOR_REWORK_COMPARISON),
  };
  return { reviewFill: fill(after), successorRework: rework(after), comparison };
}

function renderQualityGuardrailsText(data: QualityGuardrailsReport): string {
  const { reviewFill, successorRework, comparison } = data;
  const sections = comparison
    ? [
        renderReviewFillText(reviewFill),
        renderWindowComparisonText(comparison.reviewFill, REVIEW_FILL_COLUMNS),
        renderSuccessorReworkText(successorRework),
        renderWindowComparisonText(comparison.successorRework, SUCCESSOR_REWORK_COLUMNS),
      ]
    : [renderReviewFillText(reviewFill), renderSuccessorReworkText(successorRework)];
  const text = sections.join("\n\n");
  return `${text.endsWith(LIST_PRICE_CAVEAT) ? text : `${text}\n\n${LIST_PRICE_CAVEAT}`}\n`;
}

export const qualityGuardrails = defineInsight<QualityGuardrailsOptions, QualityGuardrailsReport>({
  id: "Q13",
  name: "quality-guardrails",
  description: "Review fill and successor rework for the window, and with a before window each one's change, after minus before",
  options: {
    beforeSince: isoTime.optional().describe("start of the before window, inclusive; needs --before-until"),
    beforeUntil: isoTime.optional().describe("end of the before window, exclusive; needs --before-since"),
    bootRequests: z.number().int().positive().optional().describe("a successor's first main-thread requests that count as its boot"),
  },
  flags: {
    beforeSince: { long: "--before-since", description: "ISO timestamp or date, inclusive" },
    beforeUntil: { long: "--before-until", description: "ISO timestamp or date, exclusive" },
    bootRequests: { long: "--boot-requests", description: "boot requests per successor (default 30)" },
  },
  schema: qualityGuardrailsSchema,
  answer(db, report, options) {
    refuseSessionScope("quality-guardrails", report.scope, "; it covers every session in the window");
    const before = beforeWindow(options);
    const data = guardrails(db, { since: report.since ?? null, until: report.until ?? null }, before, options.bootRequests);
    return { data, text: renderQualityGuardrailsText(data) };
  },
});
