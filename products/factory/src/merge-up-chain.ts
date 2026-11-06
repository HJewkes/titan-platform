import { z } from "zod";
import { MERGE_UP_APPROVAL, type MergeUpCommit } from "./merge-up-approval.js";
import { isRepoKey } from "./shepherd/seats.js";
import {
  BranchName,
  CarryRefusal,
  carryCacheDir,
  carryStateDir,
  ensureCache,
  fetchArgs,
  githubRemote,
  isAncestor,
  must,
  reasonOf,
  remoteBase,
  serialized,
  systemGit,
  type CarryOptions,
  type Git,
} from "./shepherd/tree-carry.js";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const MergeUpChainInput = z.strictObject({ repo: z.string().refine(isRepoKey), baseRef: BranchName, fromHead: Sha, head: Sha });
export type MergeUpChainInput = z.infer<typeof MergeUpChainInput>;

export type MergeUpChain = { ok: true; commits: MergeUpCommit[] } | { ok: false; reason: string };

const refused = (reason: string): MergeUpChain => ({ ok: false, reason });

/**
 * Reads, from a fresh fetch, whether `head` is `fromHead` plus only clean merge-ups of `baseRef`. Each commit on the
 * first-parent line must have two parents, the first the previous commit, the second on the base branch, and a tree equal
 * to `git merge-tree` of the two. Any other shape is refused with its reason, and any git failure is refused too.
 */
export async function readMergeUpChain(raw: MergeUpChainInput, options: CarryOptions = {}): Promise<MergeUpChain> {
  const parsed = MergeUpChainInput.safeParse(raw);
  if (!parsed.success) return refused("invalid merge-up input");
  const input = parsed.data;
  try {
    const dir = carryCacheDir(carryStateDir(options.stateDir), input.repo);
    const url = (options.remote ?? githubRemote)(input.repo);
    return await serialized(dir, () => walk(options.git ?? systemGit, dir, url, input, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return refused(reasonOf(error));
  }
}

async function walk(git: Git, dir: string, url: string, input: MergeUpChainInput, signal?: AbortSignal): Promise<MergeUpChain> {
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  if (input.fromHead === input.head) return refused("the head has not moved since the approved head");
  if (!(await isAncestor(git, dir, input.fromHead, input.head, signal))) return refused(`${input.fromHead} is not an ancestor of ${input.head}`);
  const limit = MERGE_UP_APPROVAL.maxMergeUps;
  const line = (await must(git, dir, ["rev-list", "--first-parent", `--max-count=${limit + 1}`, `${input.fromHead}..${input.head}`], signal)).split("\n").filter(Boolean).reverse();
  if (line.length > limit) return refused(`more than ${limit} commits since ${input.fromHead}`);
  const commits: MergeUpCommit[] = [];
  for (const sha of line) {
    const checked = await mergeUp(git, dir, input.baseRef, sha, commits.at(-1)?.sha ?? input.fromHead, signal);
    if (typeof checked === "string") return refused(checked);
    commits.push(checked);
  }
  return { ok: true, commits };
}

/** The merge-up `sha` is, or why it is not one: its first parent must be `previous`, the last commit on the PR's line. */
async function mergeUp(git: Git, dir: string, baseRef: string, sha: string, previous: string, signal?: AbortSignal): Promise<MergeUpCommit | string> {
  const parents = (await must(git, dir, ["rev-list", "--parents", "-n", "1", sha], signal)).split(" ").slice(1);
  const [firstParent, secondParent] = parents;
  if (parents.length !== 2 || firstParent === undefined || secondParent === undefined) return `${sha} has ${parents.length} parent(s), not the two of a merge-up`;
  if (firstParent !== previous) return `${sha} has first parent ${firstParent}, not ${previous} on the PR branch`;
  if (!(await isAncestor(git, dir, secondParent, remoteBase(baseRef), signal))) return `${sha} merges ${secondParent}, which is not on ${baseRef}`;
  const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", firstParent, secondParent], signal);
  if (merged.code === 1) return `${sha} merges ${secondParent} with conflicts`;
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const mergeTree = merged.stdout.trim().split("\n")[0] ?? "";
  const tree = await must(git, dir, ["rev-parse", `${sha}^{tree}`], signal);
  if (tree !== mergeTree) return `${sha} changes more than the merge of ${secondParent} brought`;
  return { sha, firstParent, secondParent, secondParentOnBase: true, tree, mergeTree };
}
