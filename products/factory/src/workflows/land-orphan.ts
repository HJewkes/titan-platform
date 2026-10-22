import type { GitHubPort } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { CiInput, CiSnapshot } from "./land-ci.js";

/**
 * How long a check waited on may stay queued or in progress before its workflow run is read, and how long it may then
 * stay so under a completed run before ci-wait reruns it. GitHub settles a finished run's jobs within seconds.
 */
const ORPHAN_GRACE_MS = 5 * 60_000;

/** A job GitHub still shows queued or in progress although the workflow run that owns it completed (tp#2215). */
export interface OrphanedCheck {
  name: string;
  status: string;
  workflowRunId: number;
  jobId: number;
}

export const OrphanedCheckRecord = z.looseObject({ name: z.string(), status: z.string(), workflowRunId: z.number(), jobId: z.number() });

/** What one ci-wait has seen: since when each check at a head was pending, and since when each job's run read completed. */
interface OrphanWatch {
  pendingSince: Map<string, number>;
  orphanSince: Map<number, number>;
}

export const orphanWatch = (): OrphanWatch => ({ pendingSince: new Map(), orphanSince: new Map() });

function firstSeen<K>(seen: Map<K, number>, key: K, now: number): number {
  if (!seen.has(key)) seen.set(key, now);
  return seen.get(key)!;
}

/**
 * The pending read with the jobs orphaned past the grace, or undefined to keep waiting. Only checks pending past the grace
 * are read again, so a short wait costs no extra call; a failed read finds none, and the wait goes on as it was.
 */
export async function orphanVerdict(port: GitHubPort, input: CiInput, pending: CiSnapshot, now: number, watch: OrphanWatch): Promise<CiSnapshot | undefined> {
  const due = (pending.waitingOn ?? []).filter((name) => now - firstSeen(watch.pendingSince, `${pending.headSha}:${name}`, now) >= ORPHAN_GRACE_MS);
  if (due.length === 0) return undefined;
  try {
    const orphaned = (await orphansAt(port, input.repo, pending.headSha, due)).filter((job) => now - firstSeen(watch.orphanSince, job.jobId, now) >= ORPHAN_GRACE_MS);
    return orphaned.length === 0 ? undefined : { ...pending, orphaned };
  } catch {
    return undefined;
  }
}

async function orphansAt(port: GitHubPort, repo: string, headSha: string, names: readonly string[]): Promise<OrphanedCheck[]> {
  const open = (await port.latestCheckRuns(repo, headSha)).filter((run) => names.includes(run.name) && run.status !== "completed" && run.workflowRunId !== null);
  const runIds = [...new Set(open.map((run) => run.workflowRunId!))];
  const completed = new Set((await Promise.all(runIds.map(async (id) => ((await port.workflowRunStatus(repo, id)) === "completed" ? [id] : [])))).flat());
  return open.filter((run) => completed.has(run.workflowRunId!)).map((run) => ({ name: run.name, status: run.status, workflowRunId: run.workflowRunId!, jobId: run.id }));
}

export interface OrphanRerunInput {
  repo: string;
  pr: number;
  headSha: string;
  jobs: OrphanedCheck[];
}

export const OrphanRerunResult = z.looseObject({
  headSha: z.string(),
  reruns: z.array(z.looseObject({ name: z.string(), jobId: z.number(), done: z.boolean(), skipped: z.string().optional() })),
});

/** One rerun post per orphaned job; a run GitHub already requeued skips as `in-progress`, which the next wait reads. */
export async function rerunOrphans(port: GitHubPort, input: OrphanRerunInput): Promise<z.infer<typeof OrphanRerunResult>> {
  const reruns = [];
  for (const job of input.jobs) reruns.push({ name: job.name, jobId: job.jobId, ...(await port.rerunJob(input.repo, job.workflowRunId, job.jobId)) });
  return { headSha: input.headSha, reruns };
}

/** Heads each drive of a run reran orphans at; each drive replays the run's rerun steps, so it rebuilds the set. */
const rerunHeads = new WeakMap<WorkflowContext, Set<string>>();

/**
 * Spends the run's one orphan rerun at this head. A head that orphans again after it throws as a ci-wait timeout, the
 * stuck-CI failure, rather than wait on a job that may never report.
 */
export function spendOrphanRerun(ctx: WorkflowContext, headSha: string, orphaned: readonly OrphanedCheck[]): void {
  const heads = rerunHeads.get(ctx) ?? rerunHeads.set(ctx, new Set()).get(ctx)!;
  if (heads.has(headSha)) {
    const jobs = orphaned.map((job) => `${job.name} (${job.status})`).join(", ");
    throw new Error(`ci-wait timed out on orphaned checks at ${headSha}: ${jobs} still open under a completed workflow run after one rerun`);
  }
  heads.add(headSha);
}
