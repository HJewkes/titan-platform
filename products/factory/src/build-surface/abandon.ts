import type { GitHubPort } from "@titan-design/github";
import { defineCommand } from "@titan-design/registry";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { BUILD_SURFACE_WORKFLOW } from "./manifest.js";

export interface AbandonArgs {
  runId: string;
  reason: string;
  /** Ends the run although a PR it opened is still open. */
  force?: boolean;
}

export interface Abandoned {
  runId: string;
  /** The gates that were open and are now cancelled with the reason. */
  cancelledGates: string[];
}

/** A refusal the caller prints as is: the run cannot be abandoned, and nothing was written. */
export class AbandonRefused extends Error {}

const LIVE: readonly WorkflowRun["status"][] = ["running", "paused", "recovery_required"];

/** The PRs the run's slices opened, read from its recorded `bs-pr` steps. */
function openedPrs(run: WorkflowRun): number[] {
  const prs = Object.values(run.stepResults)
    .filter((step) => step.stepId.startsWith("bs-pr:"))
    .flatMap((step) => z.object({ result: z.object({ pr: z.number().int() }) }).safeParse(step.data).data?.result.pr ?? []);
  return [...new Set(prs)];
}

async function refuseOpenPrs(run: WorkflowRun, repo: string, github: Pick<GitHubPort, "getPr"> | undefined): Promise<void> {
  if (!github) throw new AbandonRefused("this factory has no GitHub port to read the run's PRs; pass --force to abandon without reading them");
  for (const pr of openedPrs(run)) {
    if ((await github.getPr(repo, pr)).state === "open") throw new AbandonRefused(`${repo}#${pr} is still open; merge or close it, or pass --force`);
  }
}

function abandonable(host: FactoryHost, runId: string): WorkflowRun {
  const run = host.runtime.status(runId);
  if (!run || run.workflowName !== BUILD_SURFACE_WORKFLOW) throw new AbandonRefused(`no ${BUILD_SURFACE_WORKFLOW} run ${runId}`);
  if (!LIVE.includes(run.status)) throw new AbandonRefused(`run ${runId} is already ${run.status}`);
  return run;
}

/**
 * Ends a build-surface run whose PR was merged or closed outside Shepherd. The runtime's cancel cancels the run's open
 * gates with the reason, as Shepherd's own gone-elsewhere sweep does; no gate is answered, so no authority is claimed.
 */
export async function abandonBuildSurface(host: FactoryHost, github: Pick<GitHubPort, "getPr"> | undefined, args: AbandonArgs): Promise<Abandoned> {
  const run = abandonable(host, args.runId);
  if (!args.force) await refuseOpenPrs(run, run.params.repo ?? "", github);
  const cancelledGates = host.pendingGates().filter((gated) => gated.runId === args.runId).map(({ gate }) => gate.id);
  host.runtime.cancel(args.runId, `abandoned: ${args.reason}`, { abandon: true });
  return { runId: args.runId, cancelledGates };
}

export const buildSurfaceAbandonCommand = defineCommand<AbandonArgs, Abandoned, FactoryContext>({
  name: "factory.build-surface.abandon",
  description: "End a build-surface run whose PR was merged outside Shepherd, cancelling its open gates with the reason; refused while a PR it opened is open unless forced",
  args: z.object({ runId: z.string().min(1), reason: z.string().trim().min(1), force: z.boolean().optional() }),
  result: z.custom<Abandoned>(),
  run: async (args, ctx) => abandonBuildSurface(ctx.host, ctx.shepherd?.port, args),
});
