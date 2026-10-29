import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildDigestPrompt, type DigestPrompt } from "./digest-prompt.js";
import type { Retriever } from "./digest-retrieval.js";
import { totalOf, type ScoreCard } from "./score-card.js";
import type { DigestRunner } from "./seams.js";
import { appendRow, type RowOutcome, type StepRow } from "./step-rows.js";

const DigestRowSchema = z.object({ step: z.string(), outcome: z.string(), started_at: z.string() });

const SYSTEM_PROMPT = "You write a digest of one video transcript as Markdown. Reply with the digest and nothing else.";
const MAX_BUDGET_USD = 0.75;
/** Plan section 3, step 6: the owner reads one digest a day, so the cap is 3. */
export const DAILY_DIGEST_CAP = 3;

export interface DigestDeps {
  runner: DigestRunner;
  retriever: Retriever;
  model: string;
  rowsDir: string;
  runId: string;
  workflowVersion: string;
  thresholdTotal: number;
  alsoIfAnyAxis: number;
  cap?: number;
  now?: () => Date;
}

interface DigestInput {
  id: string;
  source: string | null;
  title: string;
  card: ScoreCard;
  transcriptPath: string;
  partial?: boolean;
}

export type DigestResult =
  | { status: "written"; path: string; costUsd: number }
  | { status: "below_threshold" | "capped" }
  | { status: "failed"; errorClass: string; costUsd: number };

export function isDigestWorthy(card: ScoreCard, thresholdTotal: number, alsoIfAnyAxis: number): boolean {
  return totalOf(card) >= thresholdTotal || [card.actionable, card.novelty, card.evidence].some((axis) => axis === alsoIfAnyAxis);
}

/** Counts the day's digests from the rows themselves, so a restarted tick cannot spend the cap twice. */
function digestsWrittenOn(rowsDir: string, day: string): number {
  const file = path.join(rowsDir, `steps-${day.slice(0, 7)}.jsonl`);
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => DigestRowSchema.parse(JSON.parse(line)))
    .filter((r) => r.step === "digest" && r.outcome === "ok" && r.started_at.slice(0, 10) === day).length;
}

function rowFor(deps: DigestDeps, input: DigestInput, prompt: DigestPrompt | undefined, startedAt: Date, p: Partial<StepRow>): StepRow {
  return {
    v: 1,
    run_id: deps.runId,
    workflow_version: deps.workflowVersion,
    video_id: input.id,
    source: input.source,
    step: "digest",
    attempt: 1,
    started_at: startedAt.toISOString(),
    ms: (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
    outcome: "ok",
    error_class: null,
    model: deps.model,
    prompt_sha: prompt?.promptSha ?? "",
    rubric_sha: "",
    input_sha: prompt?.inputSha ?? "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_estimate: true,
    output_path: null,
    ...p,
  };
}

function gate(deps: DigestDeps, input: DigestInput, startedAt: Date): DigestResult | undefined {
  if (!isDigestWorthy(input.card, deps.thresholdTotal, deps.alsoIfAnyAxis)) {
    appendRow(deps.rowsDir, rowFor(deps, input, undefined, startedAt, { outcome: "skip" }));
    return { status: "below_threshold" };
  }
  if (digestsWrittenOn(deps.rowsDir, startedAt.toISOString().slice(0, 10)) >= (deps.cap ?? DAILY_DIGEST_CAP)) {
    appendRow(deps.rowsDir, rowFor(deps, input, undefined, startedAt, { outcome: "deferred", error_class: "budget" }));
    return { status: "capped" };
  }
  return undefined;
}

export const digestPathFor = (transcriptPath: string): string => transcriptPath.replace(/\.md$/, ".digest.md");

export async function digestVideo(deps: DigestDeps, input: DigestInput): Promise<DigestResult> {
  const startedAt = (deps.now ?? (() => new Date()))();
  const blocked = gate(deps, input, startedAt);
  if (blocked) return blocked;

  const transcript = readFileSync(input.transcriptPath, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  const retrieval = await deps.retriever(input.card);
  const prompt = buildDigestPrompt({ title: input.title, transcript, card: input.card, retrieval, partial: input.partial });
  const outcome = await deps.runner({ prompt: prompt.prompt, systemPrompt: SYSTEM_PROMPT, model: deps.model, maxBudgetUsd: MAX_BUDGET_USD });
  if (!outcome.ok) {
    const rowOutcome: RowOutcome = outcome.errorClass === "budget" ? "deferred" : "fail";
    appendRow(deps.rowsDir, rowFor(deps, input, prompt, startedAt, { outcome: rowOutcome, error_class: outcome.errorClass }));
    return { status: "failed", errorClass: outcome.errorClass, costUsd: 0 };
  }
  const { output, costUsd, inputTokens, outputTokens } = outcome.value;
  const outputPath = digestPathFor(input.transcriptPath);
  writeFileSync(outputPath, `${String(output).trim()}\n`);
  appendRow(deps.rowsDir, rowFor(deps, input, prompt, startedAt, { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, output_path: outputPath }));
  return { status: "written", path: outputPath, costUsd };
}
