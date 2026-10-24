import path from "node:path";
import { codeRecordRoute, codeStep, type StepRoute, type WorkflowFn } from "@titan-design/workflow";
import { z } from "zod";
import type { BeatWorker } from "../build/beat-worker.js";
import { L0_CHECKS, type L0Check } from "../eval-l0.js";
import { runResolveStage } from "../resolve-stage.js";
import type { ArtifactStore } from "./artifacts.js";
import { runAuditionStage } from "./audition-stage.js";
import { runGatherStage } from "./gather-stage.js";
import { runBridgeStage, type BridgeExec, type BridgeFile } from "./bridge.js";
import { buildCustomLayers, LAYER_STEP_IDS, layerRoutes } from "./layer-build.js";
import { runEvalStage, runRewriteStage, runScriptStage, StageFailure, type HarnessFor, type ModelStageInput, type RunnerFor } from "./model-stages.js";
import { addUsage, isBridgeStage, NO_USAGE, StageRecordSchema, stepUsage, type CachedStage, type StageName, type StageOutcome, type StageRecord } from "./records.js";
import type { GatherDeps } from "./run-gather.js";
import { runPaths, writeJson } from "./run-dir.js";
import { BODY_STEP, CHECKS_STEP } from "./stage-cache.js";
import { failedGates, runJudgedChecks, runStageChecks, type CheckJudge } from "./stage-checks.js";
import { StageSpecSchema, type StageSpec } from "./stage-spec.js";
import { kokoroEngine } from "./tts-engine.js";
import { runTtsStage, type TtsEngine } from "./tts-stage.js";

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
  ttsEngine?: () => Promise<TtsEngine>;
  /** The gather stage's outside world; gh, the transcript roots, the task list and git by default. */
  gather?: GatherDeps;
}

/** One `explainer.<stage>` run: the stage body on the spec it was started with, resolve's custom-layer builds, then the stage's checks over its artifacts. */
export const stageWorkflow = (): WorkflowFn => async (ctx) => {
  const spec = StageSpecSchema.parse(JSON.parse(ctx.param("spec") ?? "{}"));
  const body = await codeStep(ctx, `${BODY_STEP}:${spec.stage}`, spec, StageRecordSchema);
  const built = spec.stage === "resolve" ? await buildCustomLayers(ctx, spec, body) : body;
  await codeStep(ctx, `${CHECKS_STEP}:${spec.stage}`, { spec, body: built }, StageRecordSchema);
};

async function runBody(spec: StageSpec, input: ModelStageInput, deps: BodyDeps): Promise<StageOutcome> {
  const { config, stage } = spec;
  if (stage === "gather") {
    if (!config.gather) throw new Error("gather stage spec has no gather request");
    return runGatherStage(config.gather, input, deps.dataDir, deps.gather);
  }
  if (stage === "audition") return runAuditionBody(config, input, deps);
  if (stage === "script") {
    const seams = { ...(deps.runnerFor ? { runnerFor: deps.runnerFor } : {}), ...(deps.evalChecks ? { l0Checks: deps.evalChecks } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
    if (!config.model) throw new Error("script stage spec has no model");
    return runScriptStage(input, { model: config.model, ...(config.profile ? { profile: config.profile.type } : {}), ...seams });
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
  if (stage === "tts") return runTtsBody(config, input, deps);
  return runBridgeStage({
    stage, artifacts: input.artifacts, runId: input.from.runId, store: deps.store, file: deps.bridge(), exec: deps.exec,
    logDir: runPaths(deps.dataDir, input.from.runId).logs, vars: config.vars ?? {},
  });
}

function runAuditionBody(config: StageSpec["config"], input: ModelStageInput, deps: BodyDeps): Promise<StageOutcome> {
  if (!config.profile || !config.structures || !config.model || !config.judge) throw new Error("audition stage spec has no profile, structure registry, model or judge");
  const seams = { ...(deps.runnerFor ? { runnerFor: deps.runnerFor } : {}), ...(deps.harnessFor ? { harnessFor: deps.harnessFor } : {}), ...(deps.signal ? { signal: deps.signal } : {}) };
  return runAuditionStage(input, { profile: config.profile, structures: config.structures, model: config.model, judge: config.judge }, seams);
}

function runTtsBody(config: StageSpec["config"], input: ModelStageInput, deps: BodyDeps): Promise<StageOutcome> {
  if (!config.voice || !config.rates) throw new Error("tts stage spec has no voice or band rates");
  const takesDir = path.join(deps.dataDir, "tts-takes");
  return runTtsStage({ ...input, store: deps.store }, { voice: config.voice, rates: config.rates }, { engine: deps.ttsEngine ?? kokoroEngine, takesDir });
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
export function checksRoute(deps: Pick<BodyDeps, "dataDir" | "store" | "evalChecks" | "now"> & { judge?: CheckJudge }): StepRoute {
  const now = deps.now ?? (() => new Date());
  return codeRecordRoute(CHECKS_STEP, async (raw: z.input<typeof ChecksInputSchema>, step) => {
    const { spec, body } = ChecksInputSchema.parse(raw);
    const input = { artifacts: { ...spec.inputs, ...body.outputs }, store: deps.store, l0Checks: deps.evalChecks ?? L0_CHECKS };
    const run = runStageChecks(spec.stage, input);
    // A stage that already failed a gate is done; the model-backed checks would spend on a script nobody keeps.
    const judged = await runJudgedChecks(spec.stage, input, failedGates([...body.checks, ...run.checks]).length === 0 ? deps.judge : undefined);
    const endedAt = now();
    const record: StageRecord = {
      ...body, endedAt: endedAt.toISOString(), wallMs: endedAt.getTime() - Date.parse(body.startedAt), usage: addUsage(body.usage, judged.usage),
      checks: [...body.checks, ...run.checks, ...judged.checks], notes: [...body.notes, ...run.notes, ...judged.notes],
    };
    const red = failedGates(record.checks);
    if (red.length === 0) return { result: record, ...(judged.usage.calls > 0 ? { usage: stepUsage(judged.usage) } : {}) };
    const message = `${spec.stage}: gate ${red.map((check) => `${check.name} failed (${check.detail ?? "no detail"})`).join("; ")}`;
    writeJson(runPaths(deps.dataDir, step.runId).failed(spec.stage), { ...record, notes: [...record.notes, message] });
    throw new Error(message);
  });
}

/** The step ids an `explainer.<stage>` child dispatches; the host asserts each has a route. */
export const childStepIds = (stage: CachedStage): string[] => [`${BODY_STEP}:${stage}`, `${CHECKS_STEP}:${stage}`, ...(stage === "resolve" ? LAYER_STEP_IDS : [])];

/** Every route a child stage run dispatches to: its body, its checks, and resolve's custom-layer builds. */
export function childRoutes(deps: BodyDeps & { judge?: CheckJudge; worker?: BeatWorker }): StepRoute[] {
  return [bodyRoute(deps), checksRoute(deps), ...layerRoutes(deps)];
}
