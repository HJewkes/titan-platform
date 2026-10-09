import type { GitHubPort, LoggedCommit } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import { failureOf } from "./error-class.js";
import { payloadOf, stepName } from "./stats.js";

/** Recorded on a finished run, beside its sh-landed step, once a later main commit reverts its merge. */
export const REVERTED_STEP = "sh-reverted";

/** A revert later than this after its merge is not looked for, so each repo's read stays a page or two of main. */
const REVERT_WINDOW_MS = 7 * 86_400_000;

/** The merge commit is dated before sh-landed records it, and the title match needs the merge commit in the read. */
const MERGE_SLACK_MS = 3_600_000;

export interface RevertedRun {
  runId: string;
  repo: string;
  pr: number | null;
  mergeSha: string;
  revertSha: string;
}

export interface RevertSweep {
  reverted: RevertedRun[];
  /** Repos whose main could not be read; their runs are looked at again next sweep. */
  errors: { repo: string; cause: string }[];
}

export interface RevertDeps {
  runs: readonly WorkflowRun[];
  port: Pick<GitHubPort, "listDefaultBranchCommits">;
  mark(runId: string, data: { mergeSha: string; revertSha: string }): void;
  now: number;
}

interface Landed {
  run: WorkflowRun;
  repo: string;
  mergeSha: string;
  at: number;
}

function landedOf(run: WorkflowRun): Landed | undefined {
  if (Object.keys(run.stepResults).some((key) => stepName(key) === REVERTED_STEP)) return undefined;
  const landed = Object.values(run.stepResults).find((result) => result.stepId === "sh-landed");
  const mergeSha = landed && payloadOf(landed).mergeSha;
  const repo = run.params.repo?.toLowerCase();
  if (!landed || typeof mergeSha !== "string" || mergeSha === "" || !repo) return undefined;
  return { run, repo, mergeSha, at: Date.parse(landed.completedAt) };
}

const subjectOf = (message: string): string => message.split("\n", 1)[0]!.trim();
/** A revert PR squash-merged through GitHub gets its own ` (#n)` after the quoted title. */
const withoutPrSuffix = (subject: string): string => subject.replace(/ \(#\d+\)$/, "");
const REVERTS_LINE = /^This reverts commit ([0-9a-f]{7,40})\b/gm;

const namesSha = (message: string, sha: string): boolean => [...message.matchAll(REVERTS_LINE)].some((match) => sha.startsWith(match[1]!));

/** The commit that reverts `mergeSha`: a `This reverts commit` line naming it, or a `Revert "<subject>"` title of the merge commit when `commits` holds it. */
export function revertOf(mergeSha: string, commits: readonly LoggedCommit[]): LoggedCommit | undefined {
  const merged = commits.find((commit) => commit.sha === mergeSha);
  const title = merged && `Revert "${subjectOf(merged.message)}"`;
  return commits.find((commit) => commit.sha !== mergeSha && (namesSha(commit.message, mergeSha) || withoutPrSuffix(subjectOf(commit.message)) === title));
}

function byRepo(landed: readonly Landed[]): Map<string, Landed[]> {
  const repos = new Map<string, Landed[]>();
  for (const merge of landed) repos.set(merge.repo, [...(repos.get(merge.repo) ?? []), merge]);
  return repos;
}

/**
 * Marks each merged run whose merge a later main commit reverted, among those merged within `REVERT_WINDOW_MS`. One
 * paged read of main per repo covers every run there, from the earliest merge it still watches.
 */
export async function sweepReverts({ runs, port, mark, now }: RevertDeps): Promise<RevertSweep> {
  const watched = runs.flatMap((run) => landedOf(run) ?? []).filter((merge) => now - merge.at <= REVERT_WINDOW_MS);
  const sweep: RevertSweep = { reverted: [], errors: [] };
  for (const [repo, merges] of byRepo(watched)) {
    try {
      const since = new Date(Math.min(...merges.map((merge) => merge.at)) - MERGE_SLACK_MS).toISOString();
      const commits = await port.listDefaultBranchCommits(repo, since);
      for (const { run, mergeSha } of merges) {
        const revert = revertOf(mergeSha, commits);
        if (!revert) continue;
        mark(run.id, { mergeSha, revertSha: revert.sha });
        sweep.reverted.push({ runId: run.id, repo, pr: Number(run.params.pr) || null, mergeSha, revertSha: revert.sha });
      }
    } catch (err) {
      sweep.errors.push({ repo, cause: failureOf(err) });
    }
  }
  return sweep;
}

/** The resync pass over the host's completed runs; `dryRun` reports the same marks and writes none. */
export function markRevertedRuns(host: FactoryHost, services: ShepherdServices, { dryRun = false, now = Date.now } = {}): Promise<RevertSweep> {
  const mark = (runId: string, data: { mergeSha: string; revertSha: string }): void => void (dryRun || host.runtime.annotate(runId, REVERTED_STEP, data));
  return sweepReverts({ runs: host.runtime.list(["completed"]), port: services.port, mark, now: now() });
}
