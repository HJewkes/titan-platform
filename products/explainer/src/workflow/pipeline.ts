import { copyFileSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { codeRecordRoute, codeStep, type StepRoute, type WorkflowFn } from "@titan-design/workflow";
import { z } from "zod";
import { JudgeConfigSchema } from "../eval-harness.js";
import type { ArtifactStore } from "./artifacts.js";
import type { BridgeFile } from "./bridge.js";
import { isCachedStage, NO_USAGE, STAGES, StageRecordSchema, type StageOutcome, type StageRecord, type Stop } from "./records.js";
import { runPaths, writeJson } from "./run-dir.js";
import { ChildStageFailure, runStageCached, type CacheDeps } from "./stage-cache.js";
import { stageSpec, VariantSchema } from "./stage-spec.js";
import { failedRecord, stageRecord } from "./stage-workflows.js";

export const VIDEO_WORKFLOW = "explainer-video";
/** Bumped whenever the stage list or a stage's inputs change, so a run never replays under another shape. */
export const VIDEO_WORKFLOW_VERSION = "x3";

/** Everything a run needs, stored as its one param, so a resumed run rebuilds the same routes. */
export const RunPlanSchema = z.object({
  from: z.enum(STAGES),
  /** The last stage to run; a run that stops before `export` never reaches the theater. */
  to: z.enum(STAGES).default("export"),
  baseRunId: z.string().optional(),
  /** The video this run makes; absent means the first run of a new video, whose id is the run's own. */
  videoId: z.string().optional(),
  /** Known before the first stage that runs: the run inputs, the base run's outputs after `--from`, then the pins. */
  artifacts: z.record(z.string(), z.string()),
  /** The base run's records for the stages before `from`. */
  reused: z.array(StageRecordSchema),
  budgetUsd: z.number().positive(),
  scriptModel: z.string(),
  judge: JudgeConfigSchema,
  rounds: z.number().int().positive(),
  /** Stage → the artifact sha of its variant file; a stage with none runs the champion settings above. */
  variants: z.partialRecord(z.enum(STAGES), z.string()).default({}),
  /** Stage → sample index; part of the stage key, so n samples are n cached runs. */
  samples: z.partialRecord(z.enum(STAGES), z.number().int().nonnegative()).default({}),
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

/** The parent run: each stage from `from` to `to` is one code step, in order; stages before `from` replay the base run's records at no cost. */
export function videoWorkflow(plan: RunPlan, dataDir: string): WorkflowFn {
  return async (ctx) => {
    let artifacts = plan.artifacts;
    let spent = 0;
    const first = STAGES.indexOf(plan.from);
    const last = STAGES.indexOf(plan.to);
    for (const [i, stage] of STAGES.entries()) {
      const reuse = i < first ? plan.reused.find((record) => record.stage === stage) : undefined;
      if ((i < first && !reuse) || i > last) continue;
      if (!reuse && spent >= plan.budgetUsd) {
        const stop: Stop = { stage, spentUsd: spent, capUsd: plan.budgetUsd };
        writeJson(runPaths(dataDir, ctx.runId).stop, stop);
        throw new SpendCapStop(stop);
      }
      const input: StageInput = { stage, artifacts, remainingUsd: plan.budgetUsd - spent, ...(reuse ? { reuse } : {}) };
      const record = await codeStep(ctx, `stage:${stage}`, input, StageRecordSchema);
      spent += record.usage.usd;
      // A reused stage's outputs are already in the plan's artifacts, under any pin that replaces them.
      if (!reuse) artifacts = { ...artifacts, ...record.outputs };
    }
  };
}

export interface StageDeps {
  dataDir: string;
  store: ArtifactStore;
  plan: RunPlan;
  bridge: () => BridgeFile;
  cache: CacheDeps;
  now?: () => Date;
}

/** Hard links the finished files into the theater folder; a run ends here (owner answer Q2 B). */
function runExportStage(artifacts: Readonly<Record<string, string>>, store: ArtifactStore, file: BridgeFile): StageOutcome {
  mkdirSync(file.theater.dir, { recursive: true });
  const outputs: Record<string, string> = {};
  for (const [name, suffix] of Object.entries(file.theater.files)) {
    const sha = artifacts[name];
    if (sha === undefined) throw new Error(`stage export needs artifact "${name}", which no earlier stage produced`);
    const dest = path.join(file.theater.dir, `${file.theater.stem}${suffix}`);
    if (existsSync(dest)) unlinkSync(dest);
    try {
      linkSync(store.path(sha), dest);
    } catch {
      copyFileSync(store.path(sha), dest);
    }
    outputs[name] = sha;
  }
  return { outputs, notes: [`linked ${Object.keys(outputs).join(", ")} as ${file.theater.stem}.*`] };
}

function reused(base: StageRecord, baseRunId: string | undefined, at: Date): StageRecord {
  const now = at.toISOString();
  return { ...base, reusedFrom: base.reusedFrom ?? baseRunId ?? "base", cached: false, startedAt: now, endedAt: now, wallMs: 0, usage: NO_USAGE, retries: 0 };
}

async function runStage(input: StageInput, deps: StageDeps, now: () => Date): Promise<StageRecord> {
  const { stage } = input;
  if (!isCachedStage(stage)) {
    const startedAt = now();
    const outcome = runExportStage(input.artifacts, deps.store, deps.bridge());
    return stageRecord(stage, startedAt, now(), outcome);
  }
  const variantSha = deps.plan.variants[stage];
  const variant = variantSha ? { sha: variantSha, value: VariantSchema.parse(JSON.parse(deps.store.readText(variantSha))) } : undefined;
  const spec = stageSpec({
    stage, artifacts: input.artifacts, settings: deps.plan, sample: deps.plan.samples[stage] ?? 0,
    remainingUsd: input.remainingUsd, bridge: deps.bridge, ...(variant ? { variant } : {}),
  });
  return runStageCached(deps.cache, spec);
}

/** The route for every `stage:<name>` step. A failed stage still leaves its timing and spend in `failed/<stage>.json`. */
export function stageRoute(deps: StageDeps): StepRoute {
  const now = deps.now ?? (() => new Date());
  return codeRecordRoute("stage", async (raw: StageInput, step) => {
    const input = StageInputSchema.parse(raw);
    if (input.reuse) return { result: reused(input.reuse, deps.plan.baseRunId, now()) };
    const startedAt = now();
    try {
      return { result: await runStage(input, deps, now) };
    } catch (error) {
      const failed = error instanceof ChildStageFailure && error.record ? error.record : failedRecord(input.stage, startedAt, now(), error);
      writeJson(runPaths(deps.dataDir, step.runId).failed(input.stage), failed);
      throw error;
    }
  });
}
