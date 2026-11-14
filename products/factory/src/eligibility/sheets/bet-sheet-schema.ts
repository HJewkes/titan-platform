import { BetSchema, OutcomeSchema, OwnerIntentRefSchema, PredictionSchema } from "@titan-design/pm";
import { z } from "zod";

/*
 * The blocks of a `titan-bet-sheet/v1` file (TP-5755 PLAN 5.3), built from pm's planning schemas without `id` and
 * `state`: the importer's daemon assigns the id, and a sheet only ever proposes.
 */

export const BET_SHEET_SCHEMA = "titan-bet-sheet/v1";

const { shape: bet } = BetSchema;
const { shape: outcome } = OutcomeSchema;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { message: "must be a lowercase slug" });

export const FrontMatterSchema = z.strictObject({
  schema: z.literal(BET_SHEET_SCHEMA),
  slug,
  initiative: outcome.initiative,
  /** The lane's task tag; null for a lane that is a whole initiative. */
  lane: z.string().min(1).nullable(),
  week: bet.week,
  /** The digest the bets cite: `<digestDir>/<digest>.md`. */
  digest: slug,
  default_on_silence: z.string().min(1),
});

export type SheetFrontMatter = z.infer<typeof FrontMatterSchema>;

export const OutcomeBlockSchema = z.strictObject({
  local: slug,
  statement: outcome.statement,
  measure: outcome.measure,
  owner_intent: OwnerIntentRefSchema.optional(),
});

/** A sheet is written before the metric is measured, so the baseline may still be unknown. */
const SheetPredictionSchema = z.strictObject({ ...PredictionSchema.shape, baseline: z.number().nullable() });

export const BetBlockSchema = z
  .strictObject({
    local: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, { message: "local must be a short token such as S1" }),
    order: bet.order,
    tasks: bet.tasks,
    selector: bet.selector,
    prediction: SheetPredictionSchema,
    cites: z.array(OwnerIntentRefSchema).min(1, { message: "a bet cites at least one intent line" }),
  })
  .refine((block) => block.tasks !== undefined || block.selector !== undefined, { message: "a bet names its tasks or a selector", path: ["tasks"] });

export type BetBlock = z.infer<typeof BetBlockSchema>;
export type OutcomeBlock = z.infer<typeof OutcomeBlockSchema>;
