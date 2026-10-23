import { copyFileSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { codeRecordRoute, codeStep, type StepRoute, type WorkflowFn } from "@titan-design/workflow";
import { z } from "zod";
import type { L0Check } from "../eval-l0.js";
import { JudgeConfigSchema } from "../eval-harness.js";
import type { ArtifactStore } from "./artifacts.js";
import { runBridgeStage, type BridgeExec, type BridgeFile } from "./bridge.js";
import { runEvalStage, runRewriteStage, runScriptStage, StageFailure, type HarnessFor, type ModelStageInput, type RunnerFor } from "./model-stages.js";
import { isBridgeStage, NO_USAGE, STAGES, StageRecordSchema, type StageName, type StageOutcome, type StageRecord, type Stop } from "./records.js";
import { runPaths, writeJson } from "./run-dir.js";

export const VIDEO_WORKFLOW = "explainer-video";
/** Bumped whenever the stage list or a stage's inputs change, so a run never replays under another shape. */
export const VIDEO_WORKFLOW_VERSION = "x1";

/** Everything a run needs, stored as its one param, so a resumed run rebuilds the same routes. */
export const RunPlanSchema = z.object({
  from: z.enum(STAGES),
  baseRunId: z.string().optional(),
  /** Known before the first stage that runs: the run inputs, plus the base run's outputs after `--from`. */
  artifacts: z.record(z.string(), z.string()),
  /** The base run's records for the stages before `from`. */
  reused: z.array(StageRecordSchema),
  budgetUsd: z.number().positive(),
  scriptModel: z.string(),
  judge: JudgeConfigSchema,
  rounds: z.number().int().positive(),
});
export type RunPlan = z.infer<typeof RunPlanSchema>;

const StageInputSchema = z.object({
  stage: z.enum(STAGES),
  artifacts: z.record(z.string(), z.string()),
  remainingUsd: z.number(),
  reuse: StageRecordSchema.optional(),
});
type StageInput = z.infer<typeof StageInputSchema>;

/** Thrown by the parent at the cap, before the named stage starts; `resume` starts a new run there. */
export class SpendCapStop extends Error {
  constructor(readonly stop: Stop) {
    super(`spend cap: stopped before stage ${stop.stage}, $${stop.spentUsd.toFixed(2)} spent of a $${stop.capUsd.toFixed(2)} cap; resume with a higher --budget-usd`);
    this.name = "SpendCapStop";
  }
}

/** The parent run: each stage is one code step, in order; stages before `from` replay the base run's records at no cost. */
export function videoWorkflow(plan: RunPlan, dataDir: string): WorkflowFn {
  return async (ctx) => {
    let artifacts = plan.artifacts;
    let spent = 0;
    const first = STAGES.indexOf(plan.from);
    for (const [i, stage] of STAGES.entries()) {
      const reuse = i < first ? plan.reused.find((record) => record.stage === stage) : undefined;
      if (i < first && !reuse) continue;
      if (!reuse && spent >= plan.budgetUsd) {
        const stop: Stop = { stage, spentUsd: spent, capUsd: plan.budgetUsd };
        writeJson(runPaths(dataDir, ctx.runId).stop, stop);
        throw new SpendCapStop(stop);
      }
      const input: StageInput = { stage, artifacts, remainingUsd: plan.budgetUsd - spent, ...(reuse ? { reuse } : {}) };
      const record = await codeStep(ctx, `stage:${stage}`, input, StageRecordSchema);
      spent += record.usage.usd;
      artifacts = { ...artifacts, ...record.outputs };
    }
  };
}

export interface StageDeps {
  dataDir: string;
  store: ArtifactStore;
  plan: RunPlan;
  bridge: () => BridgeFile;
  exec: BridgeExec;
  runnerFor?: RunnerFor;
  harnessFor?: HarnessFor;
  /** The L0 checks the eval stage runs; all of them by default. */
  evalChecks?: readonly L0Check[];
  signal?: AbortSignal;
  now?: () => Date;
}

/** Hard links the finished files into the theater folder; a run ends here (owner answer Q2 B). */
function runExportStage(input: ModelStageInput, file: BridgeFile): StageOutcome {
  mkdirSync(file.theater.dir, { recursive: true });
  const outputs: Record<string, string> = {};
  for (const [name, suffix] of Object.entries(file.theater.files)) {
    const sha = input.artifacts[name];
    if (sha === undefined) throw new Error(`stage export needs artifact "${name}", which no earlier stage produced`);
    const dest = path.join(file.theater.dir, `${file.theater.stem}${suffix}`);
    if (existsSync(dest)) unlinkSync(dest);
    try {
      linkSync(input.store.path(sha), dest);
    } catch {
      copyFileSync(input.store.path(sha), dest);
    }
    outputs[name] = sha;
  }
  return { outputs, notes: [`linked ${Object.keys(outputs).join(", ")} as ${file.theater.stem}.*`] };
}

async function runStage(stage: StageName, input: ModelStageInput, deps: StageDeps): Promise<StageOutcome> {
  const { plan } = deps;
  if (stage === "script") {
    const seams = { ...(deps.runnerFor ? { runnerFor: deps.runnerFor } : {}), ...(deps.evalChecks ? { l0Checks: deps.evalChecks } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
    return runScriptStage(input, { model: plan.scriptModel, ...seams });
  }
  if (stage === "rewrite") return runRewriteStage(input, { judge: plan.judge, rounds: plan.rounds, ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}) });
  if (stage === "eval") return runEvalStage(input, { judge: plan.judge, ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}) }, deps.evalChecks);
  if (stage === "export") return runExportStage(input, deps.bridge());
  if (!isBridgeStage(stage)) throw new Error(`no body for stage ${stage}`);
  return runBridgeStage({ stage, artifacts: input.artifacts, runId: input.from.runId, store: deps.store, file: deps.bridge(), exec: deps.exec, logDir: runPaths(deps.dataDir, input.from.runId).logs });
}

function record(stage: StageName, startedAt: Date, endedAt: Date, outcome: StageOutcome): StageRecord {
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

function reused(base: StageRecord, baseRunId: string | undefined, at: Date): StageRecord {
  const now = at.toISOString();
  return { ...base, reusedFrom: base.reusedFrom ?? baseRunId ?? "base", startedAt: now, endedAt: now, wallMs: 0, usage: NO_USAGE, retries: 0 };
}

/** The route for every `stage:<name>` step. A failed stage still leaves its timing and spend in `failed/<stage>.json`. */
export function stageRoute(deps: StageDeps): StepRoute {
  const now = deps.now ?? (() => new Date());
  return codeRecordRoute("stage", async (raw: StageInput, step) => {
    const input = StageInputSchema.parse(raw);
    if (input.reuse) return { result: reused(input.reuse, deps.plan.baseRunId, now()) };
    const startedAt = now();
    const stageInput: ModelStageInput = { artifacts: input.artifacts, store: deps.store, from: { runId: step.runId, stage: input.stage }, remainingUsd: input.remainingUsd };
    try {
      const outcome = await runStage(input.stage, stageInput, deps);
      return { result: record(input.stage, startedAt, now(), outcome) };
    } catch (error) {
      const spent = error instanceof StageFailure ? { usage: error.usage, retries: error.retries } : {};
      const failed = record(input.stage, startedAt, now(), { outputs: {}, ...spent, checks: [], notes: [error instanceof Error ? error.message : String(error)] });
      writeJson(runPaths(deps.dataDir, step.runId).failed(input.stage), failed);
      throw error;
    }
  });
}
