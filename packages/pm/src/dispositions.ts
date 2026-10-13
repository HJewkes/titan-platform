import { z } from "zod";
import type { ReviewItem } from "./review-summary.js";
import { TASK_ID_REGEX } from "./task.js";
import { readTsv } from "./tsv.js";

/**
 * How a review item ended. `task`, `dup` and `fold` name a task id: the task filed for it, the
 * task it duplicates, or the task it was folded into. `drop` and `pending-owner` give a reason;
 * `pending-owner` is for a brief that says "none filed", where the owner's plan file decides.
 */
export const DISPOSITION_KINDS = ["task", "dup", "fold", "drop", "pending-owner"] as const;

const TASK_REF_KINDS: ReadonlySet<string> = new Set(["task", "dup", "fold"]);

export const DispositionRowSchema = z
  .object({
    rec_id: z.string().min(1, { message: "rec_id is empty" }),
    summary_line: z.string().min(1, { message: "summary_line is empty" }),
    disposition: z.enum(DISPOSITION_KINDS),
    ref: z.string().min(1, { message: "ref is empty: give a task id or a reason" }),
  })
  .refine((row) => !TASK_REF_KINDS.has(row.disposition) || TASK_ID_REGEX.test(row.ref), {
    message: "a task, dup or fold row needs a task id in ref (e.g. TP-12)",
    path: ["ref"],
  });

export type DispositionRow = z.infer<typeof DispositionRowSchema>;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

const COLUMNS = ["rec_id", "summary_line", "disposition", "ref"] as const;

/** Parses `dispositions.tsv`. Throws on the first bad row, naming its line. */
export function parseDispositions(tsv: string): DispositionRow[] {
  return readTsv(tsv, COLUMNS, "dispositions.tsv").map(({ line, fields }) => {
    const result = DispositionRowSchema.safeParse(fields);
    if (result.success) return result.data;
    throw new Error(`dispositions.tsv:${line}: ${result.error.issues.map((i) => i.message).join("; ")}`);
  });
}

export interface DispositionCheck {
  ok: boolean;
  /** Review items with no row. */
  missing: ReviewItem[];
  /** Row ids that name no review item, usually a typo that would otherwise hide a missing row. */
  unknown: string[];
  /** Ids with more than one row, so the item's ending is ambiguous. */
  duplicated: string[];
}

/**
 * Matches rows to review items by id, never by count: three items and three rows still fail
 * when one row names an item twice or names something that is not an item.
 */
export function checkDispositions(items: readonly ReviewItem[], rows: readonly DispositionRow[]): DispositionCheck {
  const expected = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { rec_id } of rows) {
    if (seen.has(rec_id)) duplicated.add(rec_id);
    seen.add(rec_id);
  }
  const missing = items.filter((item) => !seen.has(item.id));
  const unknown = [...seen].filter((id) => !expected.has(id));
  const ok = missing.length === 0 && unknown.length === 0 && duplicated.size === 0;
  return { ok, missing, unknown, duplicated: [...duplicated] };
}
