import { codeRecordRoute, codeStep, type StepRoute, type StepUsage, type WorkflowFn } from "@titan-design/workflow";
import { z } from "zod";
import { L0_CHECKS, type L0Check } from "../eval-l0.js";
import { runResolveStage } from "../resolve-stage.js";
import type { ArtifactStore } from "./artifacts.js";
import { runAuditionStage } from "./audition-stage.js";
import { runBridgeStage, type BridgeExec, type BridgeFile } from "./bridge.js";
import { runEvalStage, runRewriteStage, runScriptStage, StageFailure, type HarnessFor, type ModelStageInput, type RunnerFor } from "./model-stages.js";
import { isBridgeStage, NO_USAGE, StageRecordSchema, type StageName, type StageOutcome, type StageRecord, type StageUsage } from "./records.js";
import { runPaths, writeJson } from "./run-dir.js";
import { BODY_STEP, CHECKS_STEP } from "./stage-cache.js";
import { failedGates, runStageChecks } from "./stage-checks.js";
import { StageSpecSchema, type StageSpec } from "./stage-spec.js";

interface BodyDeps {
  dataDir: string;
  store: ArtifactStore;
  bridge: () => BridgeFile;
  exec: BridgeExec;
  runnerFor?: RunnerFor;
  harnessFor?: HarnessFor;
  /** The L0 checks the script, rewrite and eval stages run; all of them by default. */
  evalChecks?: readonly L0Check[];
  signal?: AbortSignal;
  now?: () => Date;
}

/** One `explainer.<stage>` run: the stage body on the spec it was started with, then the stage's checks over its artifacts. */
export const stageWorkflow = (): WorkflowFn => async (ctx) => {
  const spec = StageSpecSchema.parse(JSON.parse(ctx.param("spec") ?? "{}"));
  const body = await codeStep(ctx, `${BODY_STEP}:${spec.stage}`, spec, StageRecordSchema);
  await codeStep(ctx, `${CHECKS_STEP}:${spec.stage}`, { spec, body }, StageRecordSchema);
};

async function runBody(spec: StageSpec, input: ModelStageInput, deps: BodyDeps): Promise<StageOutcome> {
  const { config, stage } = spec;
  if (stage === "audition") {
    if (!config.profile || !config.structures || !config.model || !config.judge) throw new Error("audition stage spec has no profile, structure registry, model or judge");
    const seams = { ...(deps.runnerFor ? { runnerFor: deps.runnerFor } : {}), ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
    return runAuditionStage(input, { profile: config.profile, structures: config.structures, model: config.model, judge: config.judge }, seams);
  }
  if (stage === "script") {
    const seams = { ...(deps.runnerFor ? { runnerFor: deps.runnerFor } : {}), ...(deps.evalChecks ? { l0Checks: deps.evalChecks } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
    if (!config.model) throw new Error("script stage spec has no model");
    return runScriptStage(input, { model: config.model, ...seams });
  }
  if (stage === "rewrite") {
    if (!config.judge || config.rounds === undefined) throw new Error("rewrite stage spec has no judge or rounds");
    return runRewriteStage(input, { judge: config.judge, rounds: config.rounds, ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}) });
  }
  if (stage === "resolve") {
    if (!config.doctrine) throw new Error("resolve stage spec has no doctrine sha");
    return runResolveStage(input, { doctrine: config.doctrine });
  }
  if (stage === "eval") {
    if (!config.judge) throw new Error("eval stage spec has no judge");
    return runEvalStage(input, { judge: config.judge, ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}) }, deps.evalChecks);
  }
  return runBridgeStage({
    stage, artifacts: input.artifacts, runId: input.from.runId, store: deps.store, file: deps.bridge(), exec: deps.exec,
    logDir: runPaths(deps.dataDir, input.from.runId).logs, vars: config.vars ?? {},
  });
}

export function stageRecord(stage: StageName, startedAt: Date, endedAt: Date, outcome: StageOutcome): StageRecord {
  return {
    stage,
    bridged: isBridgeStage(stage),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wallMs: endedAt.getTime() - startedAt.getTime(),
    usage: outcome.usage ?? NO_USAGE,
    retries: outcome.retries ?? 0,
    outputs: outcome.outputs,
    checks: outcome.checks ?? [],
    notes: outcome.notes ?? [],
  };
}

/** The record of a stage that threw: its timing, and its spend when the body had spent before failing. */
export function failedRecord(stage: StageName, startedAt: Date, endedAt: Date, error: unknown): StageRecord {
  const spent = error instanceof StageFailure ? { usage: error.usage, retries: error.retries, checks: [...error.checks] } : {};
  return stageRecord(stage, startedAt, endedAt, { outputs: {}, checks: [], ...spent, notes: [error instanceof Error ? error.message : String(error)] });
}

const stepUsage = (usage: StageUsage): StepUsage => ({
  costUsd: usage.usd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
  ...(usage.costUnknown ? { costUnknown: true as const } : {}),
});

/** The route for every child's `body:<stage>` step. A failed body leaves its record in the child's `failed/<stage>.json`. */
export function bodyRoute(deps: BodyDeps): StepRoute {
  const now = deps.now ?? (() => new Date());
  return codeRecordRoute(BODY_STEP, async (raw: StageSpec, step) => {
    const spec = StageSpecSchema.parse(raw);
    const startedAt = now();
    const input: ModelStageInput = { artifacts: spec.inputs, store: deps.store, from: { runId: step.runId, stage: spec.stage }, remainingUsd: spec.remainingUsd };
    try {
      const outcome = await runBody(spec, input, deps);
      const record = stageRecord(spec.stage, startedAt, now(), outcome);
      return { result: record, ...(record.usage.calls > 0 ? { usage: stepUsage(record.usage) } : {}) };
    } catch (error) {
      writeJson(runPaths(deps.dataDir, step.runId).failed(spec.stage), failedRecord(spec.stage, startedAt, now(), error));
      throw error;
    }
  });
}

const ChecksInputSchema = z.object({ spec: StageSpecSchema, body: StageRecordSchema });

/**
 * The route for every child's `checks:<stage>` step: it adds the stage's checks to the body's record. Any failed
 * gate, the body's or its own, fails the stage and leaves the record, verdicts included, in `failed/<stage>.json`.
 */
export function checksRoute(deps: Pick<BodyDeps, "dataDir" | "store" | "evalChecks" | "now">): StepRoute {
  const now = deps.now ?? (() => new Date());
  return codeRecordRoute(CHECKS_STEP, async (raw: z.input<typeof ChecksInputSchema>, step) => {
    const { spec, body } = ChecksInputSchema.parse(raw);
    const run = runStageChecks(spec.stage, { artifacts: { ...spec.inputs, ...body.outputs }, store: deps.store, l0Checks: deps.evalChecks ?? L0_CHECKS });
    const endedAt = now();
    const record: StageRecord = {
      ...body, endedAt: endedAt.toISOString(), wallMs: endedAt.getTime() - Date.parse(body.startedAt),
      checks: [...body.checks, ...run.checks], notes: [...body.notes, ...run.notes],
    };
    const red = failedGates(record.checks);
    if (red.length === 0) return { result: record };
    const message = `${spec.stage}: gate ${red.map((check) => `${check.name} failed (${check.detail ?? "no detail"})`).join("; ")}`;
    writeJson(runPaths(deps.dataDir, step.runId).failed(spec.stage), { ...record, notes: [...record.notes, message] });
    throw new Error(message);
  });
}
