import type { GitHubPort, RepoSlug } from "./port.js";

/** How many base merges may sit between the approved head and the PR head, as in agent-chat's `scripts/seat/premerge`. */
export const MAX_BASE_MERGES = 5;

/**
 * The tree of a clean merge of `baseParent` and `reviewed` (`git merge-tree --write-tree`), or null
 * when they conflict. The package does no git, so the caller supplies it.
 */
export type CleanMergeTree = (baseParent: string, reviewed: string) => Promise<string | null>;

export interface ApprovedHeadWalkInput {
  headSha: string;
  approvedHead: string;
  baseRef: string;
  maxBaseMerges?: number;
  /** Absent, or failing, any head other than the approved one is refused: shape alone cannot rule out an evil merge. */
  cleanMergeTree?: CleanMergeTree;
}

/**
 * Whether `headSha` is `approvedHead` plus only merges of the base branch. On success `baseParents`
 * holds each merge's base-side parent, newest first; on failure `reasons` say why in premerge's words.
 */
export type ApprovedHeadWalk = { headSha: string; approvedHead: string } & ({ ok: true; baseParents: string[] } | { ok: false; reasons: string[] });

/**
 * Follows first parents from the head through two-parent merges until one has the approved head
 * as a parent. Each merge's other parent must be on the base branch and inside the newest one, or
 * the newest merge could have dropped base commits an earlier one brought in. Last, the head's tree
 * must equal a clean merge of the newest base parent into the approved head, which proves no merge
 * changed PR content, conflict resolutions included.
 */
export async function approvedHeadWalk(port: GitHubPort, repo: RepoSlug, input: ApprovedHeadWalkInput): Promise<ApprovedHeadWalk> {
  const { headSha, approvedHead } = input;
  if (headSha === approvedHead) return { headSha, approvedHead, ok: true, baseParents: [] };
  const walked = await walkToApproved(port, repo, input);
  if (typeof walked === "string") return { headSha, approvedHead, ok: false, reasons: [walked] };
  const problem = (await baseOrderProblem(port, repo, walked.baseParents, input.baseRef)) ?? (await treeProblem(input, walked));
  return problem ? { headSha, approvedHead, ok: false, reasons: [problem] } : { headSha, approvedHead, ok: true, baseParents: walked.baseParents };
}

interface Walked {
  baseParents: string[];
  headTree: string | undefined;
}

async function treeProblem({ headSha, approvedHead, cleanMergeTree }: ApprovedHeadWalkInput, { baseParents, headTree }: Walked): Promise<string | undefined> {
  const [newest] = baseParents;
  const plus = baseParents.length > 1 ? "its base merges" : "a base merge";
  if (cleanMergeTree === undefined || newest === undefined) return `no merge-tree proof that head ${headSha} is reviewed ${approvedHead} plus ${plus}`;
  let tree: string | null;
  try {
    tree = await cleanMergeTree(newest, approvedHead);
  } catch (error) {
    return `merge-tree of reviewed ${approvedHead} and merged parent ${newest} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (tree === null) return `reviewed ${approvedHead} conflicts with merged parent ${newest}`;
  return headTree !== undefined && tree === headTree ? undefined : `head ${headSha} differs from reviewed ${approvedHead} plus ${plus}`;
}

/** The base-side parents, newest first, or the reason the chain does not reach the approved head. */
async function walkToApproved(port: GitHubPort, repo: RepoSlug, { headSha, approvedHead, maxBaseMerges = MAX_BASE_MERGES }: ApprovedHeadWalkInput): Promise<Walked | string> {
  const others: string[] = [];
  let sha = headSha;
  let headTree: string | undefined;
  while (others.length < maxBaseMerges) {
    const { parents, tree } = await port.getCommit(repo, sha);
    if (sha === headSha) headTree = tree;
    const [first, second] = parents;
    if (parents.length !== 2 || first === undefined || second === undefined) return chainFailure(others.length, sha, headSha, approvedHead);
    if (first === approvedHead) return { baseParents: [...others, second], headTree };
    if (second === approvedHead) return { baseParents: [...others, first], headTree };
    others.push(second);
    sha = first;
  }
  return `head ${headSha} is more than ${maxBaseMerges} base merges past reviewed ${approvedHead}`;
}

function chainFailure(depth: number, sha: string, headSha: string, approvedHead: string): string {
  if (depth === 0) return `head ${headSha} is not a two-parent merge of reviewed ${approvedHead}`;
  if (depth === 1) return `reviewed ${approvedHead} is not a parent of ${headSha}`;
  return `first-parent chain from ${headSha} reaches non-merge ${sha} before reviewed ${approvedHead}`;
}

async function baseOrderProblem(port: GitHubPort, repo: RepoSlug, others: readonly string[], baseRef: string): Promise<string | undefined> {
  const [newest] = others;
  for (const other of others) {
    if (!(await isAncestor(port, repo, other, baseRef))) return `merged parent ${other} is not in ${baseRef}`;
    if (newest !== undefined && other !== newest && !(await isAncestor(port, repo, other, newest))) return `earlier merged parent ${other} is not in newest merged parent ${newest}`;
  }
  return undefined;
}

/** `sha` is inside `target` exactly when it is their merge base. */
async function isAncestor(port: GitHubPort, repo: RepoSlug, sha: string, target: string): Promise<boolean> {
  return (await port.compareFiles(repo, sha, target)).mergeBaseSha === sha;
}
