import { existsSync, readFileSync, statSync } from "node:fs";
import type { Labelled, ScorecardLabels } from "@titan-design/session-analytics";
import { z } from "zod";

const nullableText = z.string().min(1).nullable().optional();

/**
 * One row of the S3 backfill export (`labels-inferred-<date>.jsonl`): labels the census classifiers inferred once for
 * `task` (`initiative/ID`), with the heuristic behind each field in `heuristics`. Read as data; nothing here classifies.
 */
const LabelRow = z.object({
  task: z.string().min(1),
  class: z.enum(["product", "upkeep", "mixed"]).nullable().optional(),
  source: nullableText,
  serves: nullableText,
  done_reason: nullableText,
  reverted_by: nullableText,
  brief_has_done_when: z.boolean().nullable().optional(),
  heuristics: z.record(z.string(), z.string().min(1)),
});
type LabelRow = z.infer<typeof LabelRow>;

export interface LabelLoad {
  /** Keyed `initiative/ID`, as the export writes it. */
  labels: Map<string, ScorecardLabels>;
  rows: number;
  invalid: number;
  mtimeMs: number;
}

/** A field's value with the heuristic that inferred it; a null value, or one with no heuristic named, is not a label. */
function labelled<T>(row: LabelRow, field: keyof LabelRow & string, value: T | null | undefined): Labelled<T> | undefined {
  const heuristic = row.heuristics[field];
  return value === null || value === undefined || heuristic === undefined ? undefined : { value, origin: `inferred:${heuristic}` };
}

/** An undefined field reads as absent: the row's provenance and inputs hash skip it. */
function labelsOf(row: LabelRow): ScorecardLabels {
  return {
    class: labelled(row, "class", row.class),
    source: labelled(row, "source", row.source),
    serves: labelled(row, "serves", row.serves),
    doneReason: labelled(row, "done_reason", row.done_reason),
    revertedBy: labelled(row, "reverted_by", row.reverted_by),
    briefHasDoneWhen: labelled(row, "brief_has_done_when", row.brief_has_done_when),
  };
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
  const load: LabelLoad = { labels: new Map(), rows: 0, invalid: 0, mtimeMs: Math.floor(statSync(file).mtimeMs) };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = parseLine(line);
    if (row === null) load.invalid += 1;
    else {
      load.rows += 1;
      load.labels.set(row.task, labelsOf(row));
    }
  }
  return load;
}

export function labelsFor(load: LabelLoad | null, initiative: string, id: string): ScorecardLabels {
  return load?.labels.get(`${initiative}/${id}`) ?? {};
}
