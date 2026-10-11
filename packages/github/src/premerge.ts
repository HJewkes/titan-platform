import { approvedHeadWalk, type CleanMergeTree } from "./approved-head-walk.js";
import { ciVerdict, loadRequiredContexts } from "./ci-verdict.js";
import type { GitHubPort, PullRequest, RepoSlug } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, mergeReadiness, type MergeBlockReason } from "./readiness.js";

export interface PremergeInput {
  repo: RepoSlug;
  number: number;
  /** The head the caller means to merge. */
  headSha: string;
  /** The head the caller's verdict approved; the caller owns verdicts, so this is taken on trust. */
  approvedHead: string;
  /** Proves a walked approval; absent, any approved head other than the PR head fails. */
  cleanMergeTree?: CleanMergeTree;
}

/** The `--json` shape of `titan-gh premerge`; agent-chat's premerge shim builds its line from these names. */
export interface Premerge {
  repo: RepoSlug;
  number: number;
  ok: boolean;
  reasons: string[];
  head: string;
  base: string;
  required: string[];
  strict: boolean;
  behindBy: number;
}

/**
 * Check runs and statuses are judged by `ciVerdict`, as ci-wait judges them, so they are dropped here. GitHub
 * computes mergeability lazily and premerge never waited on it; a caller that needs a conflict-free merge checks it.
 */
const IGNORED: ReadonlySet<MergeBlockReason> = new Set(["unapproved", "no-required-checks", "check-pending", "check-failed", "mergeability-unknown"]);

/** The read-only half of agent-chat's `scripts/seat/premerge`: PR state, required checks, strict behind and the approved-head walk. */
export async function premerge(port: GitHubPort, input: PremergeInput): Promise<Premerge> {
  const { repo, headSha, approvedHead } = input;
  const pr = await port.getPr(repo, input.number);
  const [rules, runs, statuses] = await Promise.all([loadRequiredContexts(port, repo, pr.baseRef), port.checkRuns(repo, headSha), port.commitStatuses(repo, headSha)]);
  const approvalWalk = pr.state === "open" ? await approvedHeadWalk(port, repo, { headSha: pr.headSha, approvedHead, baseRef: pr.baseRef, ...(input.cleanMergeTree ? { cleanMergeTree: input.cleanMergeTree } : {}) }) : undefined;
  const readiness = mergeReadiness({ pr, rules, runs, requiredApps: [GITHUB_ACTIONS_APP_ID], approvedHead, ...(approvalWalk ? { approvalWalk } : {}) });
  const reasons = [
    ...(pr.headSha === headSha ? [] : [`head ${pr.headSha} != ${headSha}`]),
    ...readiness.blockers.filter((blocker) => !IGNORED.has(blocker.reason)).map((blocker) => blocker.detail),
    ...checkReasons(ciVerdict({ rules, runs, statuses })),
  ];
  return { repo, number: pr.number, ok: reasons.length === 0, reasons, head: headSha, base: pr.baseRef, required: rules.contexts, strict: rules.strict, behindBy: behindByOf(pr) };
}

function checkReasons({ verdict, reasons }: ReturnType<typeof ciVerdict>): string[] {
  if (verdict === "green") return [];
  return [`checks ${verdict}: ${reasons.join(", ")}`];
}

/** A wire that reports only whether the head is behind reads as one commit behind. */
function behindByOf(pr: PullRequest): number {
  return pr.behindBy ?? (pr.behind ? 1 : 0);
}

/** `OK <repo>#<N> head=<S> base=<base> req=[<contexts>] strict=<bool> behind=<n>` or `FAIL <repo>#<N>: <reasons>`. */
export function formatPremerge(result: Premerge): string {
  const ref = `${result.repo}#${result.number}`;
  if (!result.ok) return `FAIL ${ref}: ${result.reasons.join("; ")}`;
  return `OK ${ref} head=${result.head} base=${result.base} req=[${result.required.join(",")}] strict=${result.strict} behind=${result.behindBy}`;
}
