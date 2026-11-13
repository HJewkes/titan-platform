import { z } from "zod";
import { BET_ID_REGEX, OUTCOME_ID_REGEX, SLUG, TASK_ID_REGEX } from "./ids.js";
import { isoDate } from "./task.js";

// Planning records live in an initiative's plan/ folder, so each id carries its initiative as a prefix.

const initiativeSlug = z.string().regex(new RegExp(`^${SLUG}$`), {
  message: "initiative must be a lowercase slug (e.g. alpha)",
});

const scopedId = (suffix: string, example: string) =>
  z.string().regex(new RegExp(`^${SLUG}/${suffix}$`), { message: `id must look like ${example}` });

const outcomeId = z.string().regex(OUTCOME_ID_REGEX, { message: "id must look like alpha/faster-landing" });
const betId = z.string().regex(BET_ID_REGEX, { message: "id must look like alpha/B1" });
const freezeId = scopedId("F\\d+", "alpha/F1");
const outOfScopeId = scopedId("X\\d+", "alpha/X1");

const TASK_KEY_REGEX = new RegExp(`^${SLUG}/${TASK_ID_REGEX.source.slice(1, -1)}$`);
const taskKey = z.string().regex(TASK_KEY_REGEX, { message: "task must be <initiative>/<TASK-ID> (e.g. alpha/AL-1)" });

/** A decision (`D<n>`) or an intent digest line (`<initiative>/I<n>`): the record that holds the owner's words. */
const intentRef = z.string().regex(new RegExp(`^(D\\d+|${SLUG}/I\\d+)$`), {
  message: "intent_ref must be a decision id (D12) or an intent line id (alpha/I3)",
});

// A single token, so a pasted sentence cannot stand in for a pointer to the quote.
const quoteRef = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][\w.:/#-]*$/, { message: "quote_ref must be a reference such as msg:abc123, not quoted text" });

const text = z.string().trim().min(1);

/** Where the owner said it: the record id plus the reference to the exact quote. */
export const OwnerIntentRefSchema = z.strictObject({ intent_ref: intentRef, quote_ref: quoteRef });

export type OwnerIntentRef = z.infer<typeof OwnerIntentRefSchema>;

const belongsToInitiative = (record: { id: string; initiative: string }): boolean =>
  record.id.startsWith(`${record.initiative}/`);

const initiativePrefix = { message: "id must start with its initiative slug", path: ["id"] };

const OUTCOME_STATES = ["draft", "active", "retired"] as const;

/** One success statement per initiative: an outcome the owner would notice and the measure for it. */
export const OutcomeSchema = z
  .strictObject({
    id: outcomeId,
    initiative: initiativeSlug,
    statement: text,
    measure: text,
    state: z.enum(OUTCOME_STATES),
    owner_intent: OwnerIntentRefSchema.optional(),
  })
  .refine(belongsToInitiative, initiativePrefix);

export type Outcome = z.infer<typeof OutcomeSchema>;

const PREDICTION_DIRECTIONS = ["increase", "decrease"] as const;

/** What the bet is expected to move, from where, to what, and when the reading is due. */
export const PredictionSchema = z.strictObject({
  metric: text,
  direction: z.enum(PREDICTION_DIRECTIONS),
  baseline: z.number(),
  expected: z.number(),
  read_by: isoDate,
});

export type Prediction = z.infer<typeof PredictionSchema>;

const BET_STATES = ["proposed", "selected", "dropped", "done"] as const;

const ISO_WEEK_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export const BetSchema = z
  .strictObject({
    id: betId,
    initiative: initiativeSlug,
    week: z.string().regex(ISO_WEEK_REGEX, { message: "week must be an ISO week such as 2026-W47" }),
    outcome: outcomeId,
    order: z.number().int().positive(),
    tasks: z.array(taskKey).optional(),
    selector: text.optional(),
    prediction: PredictionSchema,
    state: z.enum(BET_STATES),
    cites: z.array(OwnerIntentRefSchema).optional(),
  })
  .refine(belongsToInitiative, initiativePrefix)
  .refine((bet) => bet.tasks !== undefined || bet.selector !== undefined, {
    message: "a bet names its tasks or a selector",
    path: ["tasks"],
  });

export type Bet = z.infer<typeof BetSchema>;

export const FreezeEndConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("date"), date: isoDate }),
  z.strictObject({ kind: z.literal("task-done"), task: taskKey }),
  z.strictObject({ kind: z.literal("measure"), metric: text, direction: z.enum(PREDICTION_DIRECTIONS), threshold: z.number() }),
  z.strictObject({ kind: z.literal("owner") }),
]);

export type FreezeEndCondition = z.infer<typeof FreezeEndConditionSchema>;

const FREEZE_SETTERS = ["owner", "decider"] as const;

export const FreezeSchema = z
  .strictObject({
    id: freezeId,
    initiative: initiativeSlug,
    tag: text.optional(),
    selector: text.optional(),
    reason: text,
    end_condition: FreezeEndConditionSchema,
    set_by: z.enum(FREEZE_SETTERS),
    ...OwnerIntentRefSchema.shape,
  })
  .refine(belongsToInitiative, initiativePrefix)
  .refine((freeze) => (freeze.tag === undefined) !== (freeze.selector === undefined), {
    message: "a freeze names exactly one of tag or selector",
    path: ["tag"],
  });

export type Freeze = z.infer<typeof FreezeSchema>;

/** Work the owner ruled out, with the reference and date of the statement that did so. */
export const OutOfScopeSchema = z
  .strictObject({
    id: outOfScopeId,
    initiative: initiativeSlug,
    statement: text,
    ...OwnerIntentRefSchema.shape,
    date: isoDate,
    revisit_when: text.optional(),
  })
  .refine(belongsToInitiative, initiativePrefix);

export type OutOfScope = z.infer<typeof OutOfScopeSchema>;
