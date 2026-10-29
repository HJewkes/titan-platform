import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type RowOutcome = "ok" | "skip" | "retry" | "fallback" | "fail" | "deferred";

/** One step attempt (plan section 5); friction is every row whose outcome is not `ok`. */
export interface StepRow {
  v: 1;
  video_id: string | null;
  source: string;
  step: string;
  attempt: number;
  started_at: string;
  ms: number;
  outcome: RowOutcome;
  error_class: string | null;
}

export function appendRows(dir: string, rows: StepRow[]): void {
  for (const row of rows) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `steps-${row.started_at.slice(0, 7)}.jsonl`), `${JSON.stringify(row)}\n`);
  }
}
