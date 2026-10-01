import { z } from "zod";
import { OUTCOMES, PICK_TYPES, classifyOutcome, stripRecommended } from "./outcome.js";

export const LEDGER_SOURCES = ["transcript", "note", "queue", "decided", "endorse", "morning"] as const;
export const ANSWERED_BY = ["owner-terminal", "owner-remote", "decider", "overrule"] as const;
export const ROUTES = ["owner-now", "owner-queue", "decider"] as const;

/** Where the row came from, precise enough to re-read the original bytes. */
export const LedgerLocatorSchema = z.object({
  path: z.string().min(1),
  byteOffset: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  toolUseId: z.string().optional(),
  msgId: z.string().optional(),
});

export const LedgerOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export const PredictionSchema = z.object({
  answer: z.string(),
  confidence: z.number().min(0).max(1),
  principleIds: z.array(z.string()),
  escalate: z.boolean(),
});

const OptionInputSchema = z.union([
  z.string().transform((label) => ({ label })),
  LedgerOptionSchema,
]);

/** Every v2 field, plus v1's `class`, `pick_type`, `free_text`, `session_id` and `tool_use_id`. */
const LedgerRowInputSchema = z.object({
  key: z.string().min(1),
  v: z.union([z.literal(1), z.literal(2)]).default(1),
  source: z.enum(LEDGER_SOURCES),
  asked_at: z.string().nullable(),
  answered_at: z.string().nullable().default(null),
  locator: LedgerLocatorSchema.nullable().default(null),
  session_id: z.string().nullable().default(null),
  tool_use_id: z.string().nullable().default(null),
  initiative: z.string().nullable(),
  category: z.string().optional(),
  class: z.string().optional(),
  header: z.string().nullable(),
  question: z.string(),
  options: z.array(OptionInputSchema),
  recommended: z.string().nullable(),
  answer: z.string().nullable(),
  pick_type: z.enum(PICK_TYPES).optional(),
  free_text: z.string().nullable().default(null),
  outcome: z.enum(OUTCOMES).nullable().optional(),
  answered_by: z.enum(ANSWERED_BY).default("owner-terminal"),
  route: z.enum(ROUTES).nullable().default(null),
  prediction: PredictionSchema.nullable().default(null),
  unclaimed: z.boolean().default(false),
});

type LedgerRowInput = z.output<typeof LedgerRowInputSchema>;

function upgrade({ class: v1Class, category, outcome, ...row }: LedgerRowInput) {
  const derived =
    outcome !== undefined
      ? outcome
      : classifyOutcome({
          answer: row.answer,
          options: row.options.map((o) => o.label),
          recommended: row.recommended,
          pickType: row.pick_type,
        });
  return {
    ...row,
    category: category ?? v1Class ?? "other",
    recommended: row.recommended === null ? null : stripRecommended(row.recommended),
    outcome: derived,
  };
}

/**
 * A ledger row. Parses v2 rows and active-work's v1 `PrecedentRow` alike: a v1 row keeps
 * `v: 1`, its `class` becomes `category` and its `pick_type` yields `outcome`.
 */
export const LedgerRowSchema = LedgerRowInputSchema.transform(upgrade);

export type LedgerRow = z.output<typeof LedgerRowSchema>;
export type LedgerRowWire = z.input<typeof LedgerRowSchema>;
export type LedgerSourceName = (typeof LEDGER_SOURCES)[number];
export type AnsweredBy = (typeof ANSWERED_BY)[number];
export type Route = (typeof ROUTES)[number];
export type LedgerLocator = z.infer<typeof LedgerLocatorSchema>;
export type LedgerOption = z.infer<typeof LedgerOptionSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
