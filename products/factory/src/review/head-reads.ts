import { isPassing, type CheckRun, type GitHubPort } from "@titan-design/github";
import type { ReviewTarget } from "@titan-design/review-panel";
import type { HeadSnapshot, ProofReaderPort, SnapshotPort } from "@titan-design/review-workflow";
import { checksAt } from "../coordinator-evidence-read.js";
import { readPrFixProof } from "../shepherd/fix-proof.js";
import { sleep } from "../workflows/deadline.js";
import type { CiRead } from "./format.js";
import { readPrFacts } from "./pr-facts.js";

/**
 * TP-4635: with no required contexts to read, every check run at the head stands in. All completed and none red is green;
 * a head with no run yet is pending, since its CI may not have started.
 */
export function headRunsState(runs: readonly CheckRun[], head: string): HeadSnapshot["ci"] {
  const atHead = runs.filter((run) => run.headSha === head);
  if (atHead.some((run) => run.status === "completed" && !isPassing(run))) return "failing";
  return atHead.length > 0 && atHead.every(isPassing) ? "green" : "pending";
}

/** The base's required contexts when they can be read, else the head's own check runs; the read names which it took. */
export async function ciAt(port: GitHubPort, repo: string, base: string, head: string): Promise<CiRead> {
  const required = await checksAt(port, repo, base, head);
  if (required.state !== "unreadable") return { state: required.state, source: "required-checks" };
  return { state: headRunsState(await port.checkRuns(repo, head), head), source: "head-check-runs" };
}

/** The head's snapshot; `onCi` hears where its CI state came from, so the report can say. */
export function snapshotReader(port: GitHubPort, onCi: (target: ReviewTarget, ci: CiRead) => void = () => undefined): SnapshotPort {
  return {
    read: async (target) => {
      const pr = await port.getPr(target.repo, target.pr);
      const [facts, ci] = await Promise.all([readPrFacts(port, target, { head: target.head }), ciAt(port, target.repo, pr.baseRef, target.head)]);
      onCi(target, ci);
      return { pr, ci: ci.state, facts };
    },
  };
}

/**
 * One pass, no wait: a fix-proof run still going reads as an error, which leaves the head unverified rather than blocking
 * the CLI for the run's half hour. Preflight stops on pending CI before it weighs the proof anyway.
 */
export function prProofReader(port: GitHubPort): ProofReaderPort {
  return { read: (target) => readPrFixProof(port, target, { now: Date.now, sleep, timeoutMs: 0 }, new AbortController().signal) };
}
