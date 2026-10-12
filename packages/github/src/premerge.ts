import { approvedHeadWalk, type CleanMergeTree } from "./approved-head-walk.js";
import { ciVerdict, loadRequiredContexts } from "./ci-verdict.js";
import type { GitHubPort, PullRequest, RepoSlug } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, mergeReadiness, type MergeBlockReason } from "./readiness.js";

interface PremergeInput {
  repo: RepoSlug;
  number: number;
  /** The head the caller means to merge. */
  headSha: string;
  /** The head the caller's verdict approved; the caller owns verdicts, so this is taken on trust. */
  approvedHead: string;
  /**
   * A local clone's merge-tree. It proves a walked approval and checks the head merges cleanly into the
   * base branch's current tip. Absent, any approved head other than the PR head fails, and conflicts rest on GitHub's mergeability.
   */
  cleanMergeTree?: CleanMergeTree;
  /** Waits between re-reads of a PR whose mergeability GitHub has not computed; only used without `cleanMergeTree`. */
  sleep?: (ms: number) => Promise<void>;
}

/** The `--json` shape of `titan-gh premerge`; agent-chat's premerge shim builds its line from these names. */
interface Premerge {
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
 * Check runs and statuses are judged by `ciVerdict`, as ci-wait judges them, so they are dropped here. Unknown
 * mergeability is judged by `conflictReasons`, which fails it closed.
 */
const IGNORED: ReadonlySet<MergeBlockReason> = new Set(["unapproved", "no-required-checks", "check-pending", "check-failed", "mergeability-unknown"]);

/** Backoff between re-reads of a PR whose mergeability is still `unknown`. */
export const MERGEABILITY_RETRY_MS = [1000, 2000, 4000] as const;

/** The read-only half of agent-chat's `scripts/seat/premerge`: PR state, required checks, strict behind, conflicts and the approved-head walk. */
export async function premerge(port: GitHubPort, input: PremergeInput): Promise<Premerge> {
  const { repo, headSha, approvedHead, cleanMergeTree } = input;
  const pr = await readPr(port, input);
  const [rules, runs, statuses] = await Promise.all([loadRequiredContexts(port, repo, pr.baseRef), port.checkRuns(repo, headSha), port.commitStatuses(repo, headSha)]);
  const approvalWalk = pr.state === "open" ? await approvedHeadWalk(port, repo, { headSha: pr.headSha, approvedHead, baseRef: pr.baseRef, ...(cleanMergeTree ? { cleanMergeTree } : {}) }) : undefined;
  const readiness = mergeReadiness({ pr, rules, runs, requiredApps: [GITHUB_ACTIONS_APP_ID], approvedHead, ...(approvalWalk ? { approvalWalk } : {}) });
  const reasons = [
    ...(pr.headSha === headSha ? [] : [`head ${pr.headSha} != ${headSha}`]),
    ...readiness.blockers.filter((blocker) => !IGNORED.has(blocker.reason)).map((blocker) => blocker.detail),
    ...(await conflictReasons(port, repo, pr, headSha, cleanMergeTree)),
    ...checkReasons(ciVerdict({ rules, runs, statuses })),
  ];
  return { repo, number: pr.number, ok: reasons.length === 0, reasons, head: headSha, base: pr.baseRef, required: rules.contexts, strict: rules.strict, behindBy: behindByOf(pr) };
}

/** Without a local merge-tree, GitHub's mergeability is the only conflict check, so an `unknown` one is re-read a few times. */
async function readPr(port: GitHubPort, { repo, number, cleanMergeTree, sleep }: PremergeInput): Promise<PullRequest> {
  let pr = await port.getPr(repo, number);
  if (cleanMergeTree || !sleep) return pr;
  for (const ms of MERGEABILITY_RETRY_MS) {
    if (pr.state !== "open" || pr.mergeableState !== "unknown") break;
    await sleep(ms);
    pr = await port.getPr(repo, number);
  }
  return pr;
}

/**
 * A gate before a merge: a conflict, or no way to rule one out, fails. `dirty` is already a `mergeReadiness` blocker.
 * The clone merges against the base tip GitHub reports now, by sha, never a local ref: a stale or shadowed
 * `origin/<base>` would pass a head that conflicts with the real base. A clone lacking that commit fails.
 */
async function conflictReasons(port: GitHubPort, repo: RepoSlug, pr: PullRequest, headSha: string, cleanMergeTree: CleanMergeTree | undefined): Promise<string[]> {
  if (pr.state !== "open") return [];
  if (!cleanMergeTree) return pr.mergeableState === "unknown" ? [`GitHub has not computed mergeability of ${pr.headRef}, so a conflict cannot be ruled out`] : [];
  const tip = await port.getHeadSha(repo, pr.baseRef);
  if (tip === null) return [`base branch ${pr.baseRef} has no tip on GitHub, so a conflict cannot be ruled out`];
  try {
    return (await cleanMergeTree(tip, headSha)) === null ? [`merge-tree conflict vs ${pr.baseRef} tip ${tip}`] : [];
  } catch (error) {
    return [`merge-tree of ${headSha} and ${pr.baseRef} tip ${tip} failed: ${error instanceof Error ? error.message : String(error)}`];
  }
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
