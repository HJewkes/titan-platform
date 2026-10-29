import { z } from "zod";

/** One prompt family of the daily classification stage: its chunk files are `<id>_<n>.txt`, its prompt `<id>.md`. */
export interface PromptFamily {
  id: string;
  model: string;
  /** Ceiling for one chunk's call; the run reserves it before launching the next chunk. */
  callBudgetUsd: number;
  /** One output row; a row that fails it is counted unparsed and not written. */
  row: z.ZodType<Record<string, unknown>>;
  /** What the model is asked to answer, as `--json-schema`. */
  outputSchema: z.ZodType<{ rows: Record<string, unknown>[] }>;
}

const text = z.string();
const flag = z.boolean();

/** Rows keep every key the model sent, as the shell collector did; only the fields the prompts ask for are checked. */
function family(id: string, model: string, callBudgetUsd: number, row: z.ZodType<Record<string, unknown>>): PromptFamily {
  return { id, model, callBudgetUsd, row, outputSchema: z.object({ rows: z.array(row) }) };
}

const handoffLesson = z.looseObject({ handoff: text, from: text, lesson: text, kind: text, should_live_in: text, deterministic_fix: text.optional() });
const handoffShape = z.looseObject({ handoff: text, from: text, state_lines: z.number(), lesson_lines: z.number(), repeats_prior_state: flag });

export const PROMPT_FAMILIES: readonly PromptFamily[] = [
  family("c1_owner", "sonnet", 0.75, z.looseObject({ item: z.number(), kind: text, what_went_wrong: text.optional(), prevention: text, owner_of_fix: text, deterministic: flag, theme: text })),
  family("c2_followups", "haiku", 0.25, z.looseObject({ item: text, cls: text, mechanical: flag, could_be_owned_by: text, brief_gap: text.optional(), theme: text })),
  family("c3_handoffs", "sonnet", 0.75, z.union([handoffLesson, handoffShape])),
  family("c4_logs", "sonnet", 0.75, z.looseObject({ chunk: text, time: text, category: text, summary: text, est_turns_wasted: z.number().int(), fix: text, owner_of_fix: text, deterministic: flag })),
  family("c5_concerns", "haiku", 0.25, z.looseObject({ item: text, concern_kinds: z.array(text), actionable_by_coordinator: flag, noise: flag, recurring_fix: text.optional(), owner_of_fix: text })),
];
