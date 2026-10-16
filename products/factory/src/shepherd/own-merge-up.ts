import { isCarryFencedPath } from "@titan-design/authority";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { changedPathsBetween } from "./changed-paths.js";
import { isRepoKey } from "./seats.js";
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
} from "./tree-carry.js";

/** Under the approval-carry family so the step reads as awaiting approval; like the fix probe, its own route is the longer match. */
export const OWN_MERGE_UP_STEP = "sh-approval-carry:own";

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const InputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, fromHead: Sha, head: Sha });
type OwnMergeUpInput = z.infer<typeof InputSchema>;

const ResultSchema = z.object({
  carries: z.boolean(),
  rule: z.literal("own-merge-up").optional(),
  /** The head's second parent, the base commit Shepherd's update-branch merged in. */
  base: z.string().optional(),
  headTree: z.string().optional(),
  /** The tree of `git merge-tree` of the approved head and `base`. */
  mergeTree: z.string().optional(),
  /** What the base side changed since the PR left it, which none of the PR's own paths may meet and none of which may be carry-fenced (TP-2495). */
  mainPaths: z.array(z.string()).optional(),
  prPaths: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type OwnMergeUpResult = z.infer<typeof ResultSchema>;

const refuse = (reason: string, rest: Partial<OwnMergeUpResult> = {}): OwnMergeUpResult => ({ ...rest, carries: false, reason });

/** The paths both the PR and the base changed since they last shared a commit; a rename counts as a delete and an add, so both of its sides meet. */
async function overlap(git: Git, dir: string, input: OwnMergeUpInput, base: string, signal?: AbortSignal): Promise<{ prPaths: string[]; mainPaths: string[]; shared: string[] }> {
  const fork = await must(git, dir, ["merge-base", input.fromHead, base], signal);
  const prPaths = (await changedPathsBetween(git, dir, fork, input.fromHead, signal)).sort();
  const mainPaths = (await changedPathsBetween(git, dir, fork, base, signal)).sort();
  const main = new Set(mainPaths);
  return { prPaths, mainPaths, shared: prPaths.filter((path) => main.has(path)) };
}

async function probe(git: Git, dir: string, url: string, input: OwnMergeUpInput, signal?: AbortSignal): Promise<OwnMergeUpResult> {
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  const parents = (await must(git, dir, ["rev-list", "--parents", "-n", "1", input.head], signal)).split(" ").slice(1);
  const [first, base] = parents;
  if (parents.length !== 2 || first === undefined || base === undefined) return refuse(`${input.head} has ${parents.length} parent(s), not the two of a merge-up`);
  if (first !== input.fromHead) return refuse(`first parent ${first} is not the approved head ${input.fromHead}`, { base });
  if (!(await isAncestor(git, dir, base, remoteBase(input.baseRef), signal))) return refuse(`second parent ${base} is not on ${input.baseRef}`, { base });
  const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", input.fromHead, base], signal);
  if (merged.code === 1) return refuse(`${input.fromHead} conflicts with ${base}`, { base });
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const mergeTree = merged.stdout.trim().split("\n")[0] ?? "";
  const headTree = await must(git, dir, ["rev-parse", `${input.head}^{tree}`], signal);
  const facts = { base, headTree, mergeTree };
  if (headTree !== mergeTree) return refuse(`tree of ${input.head} differs from ${input.fromHead} merged onto ${base}`, facts);
  const { prPaths, mainPaths, shared } = await overlap(git, dir, input, base, signal);
  const fenced = mainPaths.filter(isCarryFencedPath);
  if (fenced.length > 0) return refuse(`${base} changes ${fenced.length} carry-fenced path(s): ${fenced.join(", ")}`, { ...facts, prPaths, mainPaths });
  if (shared.length > 0) return refuse(`${base} changes ${shared.length} file(s) the PR changes`, { ...facts, prPaths: shared, mainPaths });
  return { ...facts, carries: true, rule: "own-merge-up", prPaths, mainPaths };
}

/**
 * Is `head` exactly Shepherd's own merge of a base-branch commit into the approved `fromHead`: two parents, the first the
 * approved head, the second on the base branch, its tree git's own clean merge-tree of the two, and none of the files the
 * base side changed among the PR's own or under a carry-fenced path (authority, tool-guard, workflows)? Every failure, from bad input to a refused fetch, answers no with a reason.
 */
export async function ownMergeUp(raw: unknown, options: CarryOptions = {}): Promise<OwnMergeUpResult> {
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) return refuse(`invalid own-merge-up input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const input = parsed.data;
  try {
    const dir = carryCacheDir(carryStateDir(options.stateDir), input.repo);
    const url = (options.remote ?? githubRemote)(input.repo);
    return await serialized(dir, () => probe(options.git ?? systemGit, dir, url, input, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return refuse(reasonOf(error));
  }
}

export function ownMergeUpRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(OWN_MERGE_UP_STEP, now, (input: unknown, signal) => ownMergeUp(input, { ...options, signal }));
}

/** The durable probe for one head; a replay reuses the recorded answer. */
export async function ownMergeUpStep(ctx: WorkflowContext, input: OwnMergeUpInput): Promise<OwnMergeUpResult> {
  return step(ctx, `${OWN_MERGE_UP_STEP}:${input.head}`, input, ResultSchema);
}
