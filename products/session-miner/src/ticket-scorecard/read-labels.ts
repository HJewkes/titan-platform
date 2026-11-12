import { existsSync, readFileSync, statSync } from "node:fs";
import type { ScorecardLabels } from "@titan-design/session-analytics";
import { z } from "zod";

/**
 * One row of the S3 backfill export (`labels-inferred-<date>.jsonl`): labels the census classifiers inferred once, each
 * with the heuristic that produced it. Read as data; nothing here classifies.
 */
const LabelRow = z.object({
  initiative: z.string().min(1).optional(),
  id: z.string().min(1),
  heuristic: z.string().min(1),
  class: z.enum(["product", "upkeep", "mixed"]).optional(),
  source: z.string().min(1).optional(),
  serves: z.string().min(1).optional(),
  done_reason: z.string().min(1).optional(),
  reverted_by: z.string().min(1).optional(),
  brief_has_done_when: z.boolean().optional(),
});
type LabelRow = z.infer<typeof LabelRow>;

export interface LabelLoad {
  /** Keyed `initiative/ID`, or the bare id when the row names no initiative. */
  labels: Map<string, ScorecardLabels>;
  invalid: number;
  mtimeMs: number;
}

function labelsOf(row: LabelRow): ScorecardLabels {
  const origin = `inferred:${row.heuristic}` as const;
  const labels: ScorecardLabels = {};
  if (row.class !== undefined) labels.class = { value: row.class, origin };
  if (row.source !== undefined) labels.source = { value: row.source, origin };
  if (row.serves !== undefined) labels.serves = { value: row.serves, origin };
  if (row.done_reason !== undefined) labels.doneReason = { value: row.done_reason, origin };
  if (row.reverted_by !== undefined) labels.revertedBy = { value: row.reverted_by, origin };
  if (row.brief_has_done_when !== undefined) labels.briefHasDoneWhen = { value: row.brief_has_done_when, origin };
  return labels;
}

function parseLine(line: string): LabelRow | null {
  try {
    const parsed = LabelRow.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The inferred-labels file, or null when it is absent: labels then read as not measured. */
export function readLabels(file: string): LabelLoad | null {
  if (!existsSync(file)) return null;
  const load: LabelLoad = { labels: new Map(), invalid: 0, mtimeMs: Math.floor(statSync(file).mtimeMs) };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = parseLine(line);
    if (row === null) {
      load.invalid += 1;
      continue;
    }
    load.labels.set(row.initiative === undefined ? row.id : `${row.initiative}/${row.id}`, labelsOf(row));
  }
  return load;
}

export function labelsFor(load: LabelLoad | null, initiative: string, id: string): ScorecardLabels {
  if (load === null) return {};
  return load.labels.get(`${initiative}/${id}`) ?? load.labels.get(id) ?? {};
}
