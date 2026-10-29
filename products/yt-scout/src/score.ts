import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkTimestamps, ScoreCardSchema, totalOf, type ScoreCard, type Technique } from "./score-card.js";
import { buildScorePrompt, type ScorePrompt } from "./score-prompt.js";
import type { ScoreCallOutput, ScoreRunner, StepErrorClass, StepOutcome } from "./seams.js";
import { appendRow, writeCase, type RowOutcome, type StepRow } from "./step-rows.js";

const SYSTEM_PROMPT = "You score video transcripts against a rubric. Reply with one JSON object and nothing else.";
const MAX_BUDGET_USD = 0.25;
const MAX_ATTEMPTS = 2;
/** Plan section 3: past 2 h the score sees the first ~30k tokens and says so. */
const PARTIAL_AFTER_SECONDS = 7200;
const PARTIAL_CHARS = 120_000;

export interface ScoreDeps {
  runner: ScoreRunner;
  rubric: string;
  model: string;
  rowsDir: string;
  casesDir: string;
  runId: string;
  workflowVersion: string;
  now?: () => Date;
}

interface ScoreVideoInput {
  id: string;
  source: string | null;
  title: string;
  transcriptPath: string;
  outputPath: string;
  durationSeconds?: number;
}

interface StoredCard extends ScoreCard {
  id: string;
  title: string;
  total: number;
  partial: boolean;
  prompt_sha: string;
  model: string;
  transcript_path: string;
}

interface ScoreVideoResult {
  ok: boolean;
  card?: StoredCard;
  errorClass?: StepErrorClass | "ts_invalid";
  droppedTechniques: Technique[];
  costUsd: number;
}

/** Drops the YAML front matter the extractor writes; the description in the body stays. */
function stripFrontMatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, "");
}

const RETRYABLE: StepErrorClass[] = ["schema_invalid", "refusal"];

interface Attempt {
  outcome: StepOutcome<ScoreCallOutput>;
  card?: ScoreCard;
}

async function callOnce(deps: ScoreDeps, prompt: ScorePrompt): Promise<Attempt> {
  const outcome = await deps.runner({ prompt: prompt.prompt, systemPrompt: SYSTEM_PROMPT, model: deps.model, maxBudgetUsd: MAX_BUDGET_USD });
  if (!outcome.ok) return { outcome };
  const parsed = ScoreCardSchema.safeParse(outcome.value.output);
  if (parsed.success) return { outcome, card: parsed.data };
  const { output, costUsd, inputTokens, outputTokens } = outcome.value;
  const usage = { costUsd, inputTokens, outputTokens };
  return { outcome: { ok: false, errorClass: "schema_invalid", message: parsed.error.message, usage, raw: output } };
}

function rowFor(deps: ScoreDeps, input: ScoreVideoInput, prompt: ScorePrompt, attempt: number, startedAt: Date, p: Partial<StepRow>): StepRow {
  return {
    v: 1,
    run_id: deps.runId,
    workflow_version: deps.workflowVersion,
    video_id: input.id,
    source: input.source,
    step: "score",
    attempt,
    started_at: startedAt.toISOString(),
    ms: (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
    outcome: "ok",
    error_class: null,
    model: deps.model,
    prompt_sha: prompt.promptSha,
    rubric_sha: prompt.rubricSha,
    input_sha: prompt.inputSha,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    cost_estimate: true,
    output_path: null,
    ...p,
  };
}

function usageOf(a: Attempt): Pick<StepRow, "input_tokens" | "output_tokens" | "cost_usd"> {
  const v = a.outcome.ok ? a.outcome.value : a.outcome.usage;
  if (!v) return { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  return { input_tokens: v.inputTokens, output_tokens: v.outputTokens, cost_usd: v.costUsd };
}

export async function scoreVideo(deps: ScoreDeps, input: ScoreVideoInput): Promise<ScoreVideoResult> {
  const now = deps.now ?? (() => new Date());
  const full = stripFrontMatter(readFileSync(input.transcriptPath, "utf8"));
  const partial = (input.durationSeconds ?? 0) > PARTIAL_AFTER_SECONDS;
  const transcript = partial ? full.slice(0, PARTIAL_CHARS) : full;
  const prompt = buildScorePrompt({ title: input.title, transcript, rubric: deps.rubric, partial });
  let cost = 0;
  let last: Attempt | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = now();
    last = await callOnce(deps, prompt);
    cost += usageOf(last).cost_usd;
    const errorClass = last.outcome.ok ? null : last.outcome.errorClass;
    const retry = errorClass !== null && RETRYABLE.includes(errorClass) && attempt < MAX_ATTEMPTS;
    if (last.card) return finishCard(deps, input, prompt, { attempt, startedAt, cost, attemptResult: last, transcript, partial });
    const outcome: RowOutcome = retry ? "retry" : errorClass === "budget" ? "deferred" : "fail";
    appendRow(deps.rowsDir, rowFor(deps, input, prompt, attempt, startedAt, { ...usageOf(last), outcome, error_class: errorClass }));
    if (!retry) break;
  }
  return failResult(deps, input, prompt, last!, cost);
}

function failResult(deps: ScoreDeps, input: ScoreVideoInput, prompt: ScorePrompt, last: Attempt, cost: number): ScoreVideoResult {
  const errorClass = last.outcome.ok ? "other" : last.outcome.errorClass;
  if (errorClass === "schema_invalid" || errorClass === "refusal") {
    writeCase(deps.casesDir, {
      step: "score",
      video_id: input.id,
      label: errorClass,
      inputs: { transcript_path: input.transcriptPath, transcript_sha256: prompt.inputSha },
      prompt_sha: prompt.promptSha,
      model: deps.model,
      output: (last.outcome.ok ? last.outcome.value.output : last.outcome.raw) ?? null,
    });
  }
  return { ok: false, errorClass, droppedTechniques: [], costUsd: cost };
}

interface Finish {
  attempt: number;
  startedAt: Date;
  cost: number;
  attemptResult: Attempt;
  transcript: string;
  partial: boolean;
}

function writeCardFile(file: string, stored: StoredCard): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}

function fileTsInvalidCase(deps: ScoreDeps, input: ScoreVideoInput, prompt: ScorePrompt, card: ScoreCard, dropped: Technique[]): void {
  writeCase(deps.casesDir, {
    step: "score",
    video_id: input.id,
    label: "ts_invalid",
    inputs: { transcript_path: input.transcriptPath, transcript_sha256: prompt.inputSha },
    prompt_sha: prompt.promptSha,
    model: deps.model,
    output: { card, dropped },
  });
}

function finishCard(deps: ScoreDeps, input: ScoreVideoInput, prompt: ScorePrompt, f: Finish): ScoreVideoResult {
  const card = f.attemptResult.card!;
  const { kept, dropped } = checkTimestamps(card.techniques, f.transcript);
  const stored: StoredCard = {
    id: input.id,
    title: input.title,
    ...card,
    techniques: kept,
    total: totalOf(card),
    partial: f.partial,
    prompt_sha: prompt.promptSha,
    model: deps.model,
    transcript_path: input.transcriptPath,
  };
  writeCardFile(input.outputPath, stored);
  const tsInvalid = dropped.length > 0;
  if (tsInvalid) fileTsInvalidCase(deps, input, prompt, card, dropped);
  appendRow(
    deps.rowsDir,
    rowFor(deps, input, prompt, f.attempt, f.startedAt, {
      ...usageOf(f.attemptResult),
      outcome: tsInvalid ? "fallback" : "ok",
      error_class: tsInvalid ? "ts_invalid" : null,
      output_path: input.outputPath,
    }),
  );
  return { ok: true, card: stored, errorClass: tsInvalid ? "ts_invalid" : undefined, droppedTechniques: dropped, costUsd: f.cost };
}
