import { StepFailedError, type StepResult, type StepUsage, type WorkflowContext } from "@titan-design/workflow";
import type { ZodType } from "zod";
import { resolveLabels, verifyVerdict, type Batch, type QuotedItem, type VerifiedBatch } from "../judge/index.js";
import { batchArtifactSchema } from "./records.js";
import { readJson, writeJson, type BatchArtifact, type UsageEntry } from "./run-dir.js";

/** A verdict payload; the workflow stores dispatch data as a JSON object. */
export type Verdict = Record<string, unknown>;

/** How one stage asks for and reads a verdict. */
export interface StageJudge<V extends Verdict, T extends QuotedItem> {
  stage: "screen" | "confirm";
  schema: ZodType<V>;
  /** Re-reads a finished batch's items from disk. */
  item: ZodType<T>;
  judged: (verdict: V) => string[];
  items: (verdict: V) => T[];
  /** The route's own model; recorded with usage only, because the route, not the dispatch, picks it. */
  model: string;
  /** Judges a batch the route's model failed twice; a stage already on this model gets no third call. */
  fallbackModel: string;
}

export interface BatchJob {
  batch: Batch;
  file: string;
  round?: number;
  book?: string;
}

/** The batch message travels as a variable, so `{{…}}` in corpus text is never read as a placeholder. */
const BATCH_TEMPLATE = "{{BATCH}}";

type Attempt<T extends QuotedItem> = { ok: true; verified: VerifiedBatch<T>; result: StepResult } | { ok: false; reason: string };

function dispatchBatch<V extends Verdict, T extends QuotedItem>(
  ctx: WorkflowContext, stepId: string, job: BatchJob, judge: StageJudge<V, T>, modelOverride: string | undefined,
): Promise<StepResult<V>> {
  return ctx.dispatch(stepId, BATCH_TEMPLATE, { schema: judge.schema, ...(modelOverride ? { model: modelOverride } : {}), vars: { BATCH: job.batch.message } });
}

async function attempt<V extends Verdict, T extends QuotedItem>(
  ctx: WorkflowContext, stepId: string, job: BatchJob, judge: StageJudge<V, T>, modelOverride: string | undefined, usage: UsageEntry[],
): Promise<Attempt<T>> {
  const model = modelOverride ?? judge.model;
  try {
    const result = await dispatchBatch(ctx, stepId, job, judge, modelOverride);
    if (result.usage) usage.push({ stepId, model, usage: result.usage });
    const verdict = result.data;
    if (verdict === undefined) return { ok: false, reason: "the step recorded no verdict" };
    return { ok: true, result, verified: verifyVerdict(job.batch, resolveLabels(job.batch, { judged: judge.judged(verdict), items: judge.items(verdict) })) };
  } catch (error) {
    if (!(error instanceof StepFailedError) || ctx.signal.aborted) throw error;
    if (error.usage) usage.push({ stepId, model, usage: error.usage });
    return { ok: false, reason: error.reason };
  }
}

const trusted = <T extends QuotedItem>(outcome: Attempt<T>): outcome is Extract<Attempt<T>, { ok: true }> => outcome.ok && !outcome.verified.flagged;

const failureReason = <T extends QuotedItem>(outcome: Attempt<T>): string => (outcome.ok ? "canary mis-judged" : outcome.reason);

function summedUsage(entries: readonly UsageEntry[]): StepUsage | undefined {
  if (entries.length === 0) return undefined;
  return { costUsd: entries.reduce((sum, e) => sum + e.usage.costUsd, 0), ...(entries.some((e) => e.usage.costUnknown) ? { costUnknown: true as const } : {}) };
}

const canaryMisses = (...outcomes: Attempt<QuotedItem>[]): number => outcomes.filter((o) => o.ok && o.verified.flagged).length;

interface Outcome<T extends QuotedItem> {
  via: BatchArtifact<T>["via"];
  usage: UsageEntry[];
  misses: number;
  verified?: VerifiedBatch<T>;
  reason?: string;
}

function artifactOf<T extends QuotedItem>(job: BatchJob, judge: { stage: "screen" | "confirm" }, { via, usage, misses, verified, reason }: Outcome<T>): BatchArtifact<T> {
  const ids = job.batch.passages.map((p) => p.id);
  return {
    key: job.batch.key,
    stage: judge.stage,
    ...(job.round === undefined ? {} : { round: job.round }),
    ...(job.book === undefined ? {} : { book: job.book }),
    via,
    passageIds: ids,
    items: verified?.items ?? [],
    voided: verified?.voided ?? [],
    unjudged: verified?.unjudged ?? ids,
    flagged: verified?.flagged ?? false,
    canaryMisses: misses,
    ...(reason === undefined ? {} : { reason }),
    usage,
  };
}

type Via = Exclude<BatchArtifact<QuotedItem>["via"], "unjudged">;

interface Try {
  via: Via;
  suffix: string;
  model?: string;
}

/**
 * A failed first verdict is most often a canary left out of `judged`, which a second call on the same model clears,
 * so the stronger fallback model is paid for only when that redo fails too.
 */
function tries(judge: { model: string; fallbackModel: string }): Try[] {
  const own: Try[] = [{ via: "primary", suffix: "" }, { via: "redo", suffix: "/redo" }];
  return judge.fallbackModel === judge.model ? own : [...own, { via: "fallback", suffix: "/fallback", model: judge.fallbackModel }];
}

/** A batch finished in an earlier drive: answer from the record through the one call that counted, never paying again. */
function replayFinished<V extends Verdict, T extends QuotedItem>(ctx: WorkflowContext, itemStepId: string, job: BatchJob, judge: StageJudge<V, T>, done: BatchArtifact<T>): Promise<StepResult> {
  if (done.via === "unjudged") return ctx.seed(`${itemStepId}/unjudged`, async () => ({ data: {} }));
  const counted = tries(judge).find((t) => t.via === done.via)!;
  return dispatchBatch(ctx, itemStepId + counted.suffix, job, judge, counted.model);
}

/**
 * Judges one batch. A refusal, an invalid payload or a mis-judged canary gets one redo on the stage's own model, then
 * one call on the fallback model; if every try fails the batch is recorded unjudged and the item returns, so one
 * failure never stops the wave.
 */
export async function judgeBatch<V extends Verdict, T extends QuotedItem>(ctx: WorkflowContext, itemStepId: string, job: BatchJob, judge: StageJudge<V, T>): Promise<StepResult> {
  const done = readJson(job.file, batchArtifactSchema(judge.item));
  if (done) return replayFinished(ctx, itemStepId, job, judge, done);
  const usage: UsageEntry[] = [];
  const failed: Attempt<T>[] = [];
  for (const t of tries(judge)) {
    const outcome = await attempt(ctx, itemStepId + t.suffix, job, judge, t.model, usage);
    if (trusted(outcome)) {
      const result = failed.length === 0 ? outcome.result : { ...outcome.result, usage: summedUsage(usage) };
      return saved(job, artifactOf(job, judge, { via: t.via, usage, misses: canaryMisses(...failed), verified: outcome.verified }), result);
    }
    failed.push(outcome);
  }
  const reason = failed.map(failureReason).join("; then: ");
  const recorded = await ctx.seed(`${itemStepId}/unjudged`, async () => {
    writeJson(job.file, artifactOf<T>(job, judge, { via: "unjudged", usage, misses: canaryMisses(...failed), reason }));
    return { data: {}, output: reason };
  });
  const spent = summedUsage(usage);
  return spent ? { ...recorded, usage: spent } : recorded;
}

function saved<T>(job: BatchJob, artifact: BatchArtifact<T>, result: StepResult): StepResult {
  writeJson(job.file, artifact);
  return result;
}
