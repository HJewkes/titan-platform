import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StepErrorClass } from "./seams.js";

/** `fallback` marks a degraded result that was still kept, such as a card with a technique dropped. */
export type RowOutcome = "ok" | "skip" | "retry" | "fallback" | "fail" | "deferred";

export interface StepRow {
  v: 1;
  run_id: string;
  workflow_version: string;
  video_id: string;
  source: string | null;
  step: string;
  attempt: number;
  started_at: string;
  ms: number;
  outcome: RowOutcome;
  error_class: StepErrorClass | "ts_invalid" | null;
  model: string;
  prompt_sha: string;
  rubric_sha: string;
  input_sha: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_estimate: true;
  output_path: string | null;
}

export function appendRow(rowsDir: string, row: StepRow): void {
  mkdirSync(rowsDir, { recursive: true });
  appendFileSync(path.join(rowsDir, `steps-${row.started_at.slice(0, 7)}.jsonl`), `${JSON.stringify(row)}\n`);
}

export const VERDICTS = ["over", "under", "miss", "wrong-ts", "bad-why"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The owner's label. `total` is what the card should have scored; absent, the recorded card stands as the reference. */
export interface Gold {
  verdict: Verdict;
  total?: number;
  note?: string;
}

export interface EvalCase {
  step: string;
  video_id: string;
  label: string;
  /** Everything replay needs to rebuild the original prompt: title and partial fill the template beside the transcript. */
  inputs: { transcript_path: string; transcript_sha256: string; title: string; partial: boolean };
  prompt_sha: string;
  model: string;
  output: unknown;
  gold?: Gold;
}

export function writeCase(casesDir: string, c: EvalCase): string {
  mkdirSync(casesDir, { recursive: true });
  const file = path.join(casesDir, `${c.step}-${c.video_id}.json`);
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  return file;
}
