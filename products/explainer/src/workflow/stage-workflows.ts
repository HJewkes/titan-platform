import { codeRecordRoute, codeStep, type StepRoute, type StepUsage, type WorkflowFn } from "@titan-design/workflow";
import type { L0Check } from "../eval-l0.js";
import type { ArtifactStore } from "./artifacts.js";
import { runBridgeStage, type BridgeExec, type BridgeFile } from "./bridge.js";
import { runEvalStage, runRewriteStage, runScriptStage, StageFailure, type HarnessFor, type ModelStageInput, type RunnerFor } from "./model-stages.js";
import { isBridgeStage, NO_USAGE, StageRecordSchema, type StageName, type StageOutcome, type StageRecord, type StageUsage } from "./records.js";
import { runPaths, writeJson } from "./run-dir.js";
import { BODY_STEP } from "./stage-cache.js";
import { StageSpecSchema, type StageSpec } from "./stage-spec.js";

interface BodyDeps {
  dataDir: string;
  store: ArtifactStore;
  bridge: () => BridgeFile;
  exec: BridgeExec;
  runnerFor?: RunnerFor;
  harnessFor?: HarnessFor;
  /** The L0 checks the eval stage runs; all of them by default. */
  evalChecks?: readonly L0Check[];
  signal?: AbortSignal;
  now?: () => Date;
}

/** One `explainer.<stage>` run: a single code step that runs the stage body on the spec it was started with. */
export const stageWorkflow = (): WorkflowFn => async (ctx) => {
  const spec = StageSpecSchema.parse(JSON.parse(ctx.param("spec") ?? "{}"));
  await codeStep(ctx, `${BODY_STEP}:${spec.stage}`, spec, StageRecordSchema);
};

async function runBody(spec: StageSpec, input: ModelStageInput, deps: BodyDeps): Promise<StageOutcome> {
  const { config, stage } = spec;
  if (stage === "script") {
    const seams = { ...(deps.runnerFor ? { runnerFor: deps.runnerFor } : {}), ...(deps.evalChecks ? { l0Checks: deps.evalChecks } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
    if (!config.model) throw new Error("script stage spec has no model");
    return runScriptStage(input, { model: config.model, ...seams });
  }
  if (stage === "rewrite") {
    if (!config.judge || config.rounds === undefined) throw new Error("rewrite stage spec has no judge or rounds");
    return runRewriteStage(input, { judge: config.judge, rounds: config.rounds, ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}) });
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
  const spent = error instanceof StageFailure ? { usage: error.usage, retries: error.retries } : {};
  return stageRecord(stage, startedAt, endedAt, { outputs: {}, ...spent, checks: [], notes: [error instanceof Error ? error.message : String(error)] });
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
