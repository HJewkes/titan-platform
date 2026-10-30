import { isPassing, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";
import type { RetargetRun } from "./retarget-conflict.js";

const STALE_BASE_STEP = "sh-stale-base";
export const STALE_BASE_STEPS: readonly StepDeclaration[] = [{ id: STALE_BASE_STEP, kind: "dispatch" }];

/** Reaches past the summary steps that run after a job's failed step. */
const LOG_LINES = 500;
const REMOTE_REF = /\borigin\/([\w./-]*\w)/;

interface StaleBaseInput {
  repo: RepoSlug;
  headSha: string;
  retargetedFrom?: string;
}

const StaleBaseResult = z.looseObject({ staleBase: z.string().nullable() });

/** The remote refs `git` could not resolve, as a job that diffs against `origin/<base>` reports them. */
export function unresolvedRefs(log: string): string[] {
  const named = log.split("\n").filter((line) => line.includes("invalid reference")).map((line) => REMOTE_REF.exec(line)?.[1]);
  return [...new Set(named.filter((ref) => ref !== undefined))];
}

/** A ref that still exists failed for some other reason, so only a confirmed absence names a stale base; a failed read leaves the red a code red. */
async function readStaleBase(port: Pick<GitHubPort, "latestCheckRuns" | "jobLogTail" | "getHeadSha">, input: StaleBaseInput): Promise<z.infer<typeof StaleBaseResult>> {
  if (input.retargetedFrom !== undefined) return { staleBase: input.retargetedFrom };
  try {
    const failed = (await port.latestCheckRuns(input.repo, input.headSha)).filter((run) => run.status === "completed" && !isPassing(run) && run.workflowRunId !== null);
    const logs = await Promise.all(failed.map((run) => port.jobLogTail(input.repo, run.id, LOG_LINES).catch(() => "")));
    for (const ref of new Set(logs.flatMap(unresolvedRefs))) if ((await port.getHeadSha(input.repo, ref)) === null) return { staleBase: ref };
    return { staleBase: null };
  } catch {
    return { staleBase: null };
  }
}

export function staleBaseRoute(deps: Pick<ShepherdDeps, "port" | "now">): StepRoute {
  return codeRoute(STALE_BASE_STEP, deps.now, (input: StaleBaseInput) => readStaleBase(deps.port, input));
}

export interface StaleBaseRun extends RetargetRun {
  /** Bases a merge-main round was already asked for; replaying the recorded step results rebuilds it. */
  staleBases: Set<string>;
  staleBaseReads: number;
}

/**
 * TP-4605: `pull_request` runs keep the base they were started on, so a stacked child's red from before its parent landed
 * survives the retarget and a rerun repeats it; no code fix can clear it, and only a new head runs on the new base. Returns
 * the old base for one merge-main round per base, so a red on the head that round pushed is an ordinary code red. A run
 * replaying history recorded before this step existed skips it and keeps its ci-red wake.
 */
export async function staleBaseOf(run: StaleBaseRun, headSha: string): Promise<string | undefined> {
  const next = run.ctx.historyNext();
  if (next !== undefined && !stepIdMatches(STALE_BASE_STEP, next)) return undefined;
  const input: StaleBaseInput = { repo: run.target.repo, headSha, ...(run.retargetedFrom !== undefined && { retargetedFrom: run.retargetedFrom }) };
  const { staleBase } = await step(run.ctx, `${STALE_BASE_STEP}:${run.staleBaseReads++}`, input, StaleBaseResult);
  if (staleBase === null || run.staleBases.has(staleBase)) return undefined;
  run.staleBases.add(staleBase);
  return staleBase;
}
