import { mapItems, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { BUILD_SURFACE_STEPS, BUILD_SURFACE_WORKFLOW, FINAL_WALK } from "./manifest.js";
import { FinalWalkAnswer } from "./schemas.js";
import { runSlice, SliceOutcomeSchema, type SliceOutcome } from "./slice.js";
import { sliceRun, type RunHalt } from "./slice-run.js";
import { BuildSpecSchema, readySlices, type BuildSpec } from "./spec.js";

const INPUT_VAR = "BS_STEP_INPUT";
/** Two stopped slices stop the loop: the first is tolerated, as `maxFailures: 1` counts it, across every wave. */
const TOLERATED_STOPS = 1;

interface Progress {
  merged: Map<string, SliceOutcome>;
  stopped: Map<string, string>;
  spentUsd: number;
  stoppedBy: string | null;
  halt: RunHalt;
}

function params(ctx: WorkflowContext): { repo: string; spec: string } {
  const repo = ctx.param("repo");
  const spec = ctx.param("spec");
  if (!repo) throw new Error(`${BUILD_SURFACE_WORKFLOW}: param repo is required`);
  if (!spec) throw new Error(`${BUILD_SURFACE_WORKFLOW}: param spec is required`);
  return { repo, spec };
}

async function plan(ctx: WorkflowContext, repo: string, specPath: string): Promise<BuildSpec> {
  const schema = z.looseObject({ result: z.object({ spec: BuildSpecSchema }) });
  const planned = await ctx.dispatch("bs-plan", `{{${INPUT_VAR}}}`, { vars: { [INPUT_VAR]: JSON.stringify({ repo, specPath }) }, schema });
  return planned.data!.result.spec;
}

/** One wave: every slice whose dependencies have merged, up to three at a time, under what is left of the run's budget. */
async function wave(ctx: WorkflowContext, spec: BuildSpec, number: number, progress: Progress): Promise<boolean> {
  const ready = readySlices(spec.slices, new Set(progress.merged.keys()), new Set(progress.stopped.keys()));
  if (ready.length === 0) return false;
  const result = await mapItems(ctx, `bs-wave:${number}`, ready, (slice) => runSlice(sliceRun(ctx, spec, slice, progress.halt)), {
    key: (slice) => slice.id,
    concurrency: spec.concurrency,
    budgetUsd: spec.budgetUsd - progress.spentUsd,
    maxFailures: Math.max(0, TOLERATED_STOPS - progress.stopped.size),
  });
  progress.spentUsd += result.spentUsd;
  for (const { key, result: done } of result.results) progress.merged.set(key, SliceOutcomeSchema.parse(done.data));
  for (const { key, error } of result.failed) progress.stopped.set(key, error);
  progress.stoppedBy = result.stoppedBy;
  return result.stoppedBy === null;
}

/** The owner's one walk over the finished build; `changes` ends the run with the notes recorded in the answer. */
async function finalWalk(ctx: WorkflowContext, spec: BuildSpec, progress: Progress): Promise<void> {
  const last = [...progress.merged.values()].at(-1)!;
  const brief = {
    summary: `Walk the ${spec.repo} build: ${progress.merged.size} slices merged, $${progress.spentUsd.toFixed(2)} spent`.slice(0, 280),
    evidenceRef: `https://github.com/${spec.repo}/commit/${last.mergeSha}`,
    questions: [{ id: "decision", question: "Accept the build after the final walk?", options: [{ id: "accept", label: "Accept the build" }, { id: "changes", label: "Changes needed; file the notes" }] }],
  };
  const prompt = `Final walk of ${spec.repo} at ${last.mergeSha}: merged ${[...progress.merged.keys()].join(", ")}. Accept, or ask for changes with notes?`;
  const schema = FinalWalkAnswer(last.mergeSha);
  schema.parse((await ctx.assisted(FINAL_WALK, prompt, { schema, brief })).data);
}

/** Waves until no slice is ready; every slice merged opens the final walk, and anything else fails the run naming why. */
async function buildSurface(ctx: WorkflowContext): Promise<void> {
  const { repo, spec: specPath } = params(ctx);
  const spec = await plan(ctx, repo, specPath);
  const progress: Progress = { merged: new Map(), stopped: new Map(), spentUsd: 0, stoppedBy: null, halt: { reason: null } };
  for (let number = 0; await wave(ctx, spec, number, progress); number++);
  if (progress.merged.size === spec.slices.length) return finalWalk(ctx, spec, progress);
  const stopped = [...progress.stopped].map(([slice, reason]) => `${slice} (${reason})`);
  const waiting = spec.slices.filter((slice) => !progress.merged.has(slice.id) && !progress.stopped.has(slice.id)).map((slice) => slice.id);
  const by = progress.stoppedBy ? `, stopped by ${progress.stoppedBy}` : "";
  const merged = `${progress.merged.size} of ${spec.slices.length} slices merged${by}`;
  throw new Error(`${BUILD_SURFACE_WORKFLOW} ended with ${merged}; stopped: ${stopped.join(", ") || "none"}; not started: ${waiting.join(", ") || "none"}`);
}

export function buildSurfaceWorkflow(): WorkflowDefinition {
  return defineWorkflow({ name: BUILD_SURFACE_WORKFLOW, steps: BUILD_SURFACE_STEPS, run: buildSurface });
}
