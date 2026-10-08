import type { CarryFact } from "@titan-design/authority";
import { compileGlobs } from "@titan-design/fix-proof";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import generatedPathsJson from "./generated-paths.json" with { type: "json" };
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

export const REMERGE_STEP = "sh-remerge";

/** Which probe carried a verdict or an approval to a new head; the evidence and the review check name it. */
export type CarryRule = "tree-equal" | "remerge-empty" | "remerge-generated-only";

/** Per repo, lowercased, the globs of files a tool regenerates; a merge that touched only these resolved nothing a reviewer reads. */
const GENERATED_PATHS: Readonly<Record<string, readonly string[]>> = generatedPathsJson;

export function generatedPathsFor(repo: string): string[] {
  return [...(GENERATED_PATHS[repo.toLowerCase()] ?? [])];
}

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const RemergeInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, fromHead: Sha, head: Sha, generated: z.array(z.string().min(1)) });
type RemergeInput = z.infer<typeof RemergeInputSchema>;

const RemergeResultSchema = z.object({
  carries: z.boolean(),
  rule: z.enum(["remerge-empty", "remerge-generated-only"]).optional(),
  base: z.string().optional(),
  headTree: z.string().optional(),
  remergeTree: z.string().optional(),
  /** Every path the head's remerge-diff or the remerge's conflicts touch. */
  paths: z.array(z.string()).optional(),
  /** The paths among `paths` the repo declares generated. */
  generatedPaths: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type RemergeResult = z.infer<typeof RemergeResultSchema>;

/** The base commit merged in when `head` is exactly `fromHead` plus one merge of a commit on the base branch, else why not. */
async function mergedBase(git: Git, dir: string, input: RemergeInput, signal?: AbortSignal): Promise<string | RemergeResult> {
  const parents = (await must(git, dir, ["rev-list", "--parents", "-n", "1", input.head], signal)).split(" ").slice(1);
  const [first, base] = parents;
  if (parents.length !== 2 || first !== input.fromHead || base === undefined) return { carries: false, reason: `${input.head} is not ${input.fromHead} plus one merge` };
  if (!(await isAncestor(git, dir, base, remoteBase(input.baseRef), signal))) return { carries: false, base, reason: `second parent ${base} is not on ${input.baseRef}` };
  return base;
}

/** The tree `git show --remerge-diff` compares the head against: git's own merge of the parents in order, conflict markers and all. */
async function remergeOf(git: Git, dir: string, fromHead: string, base: string, signal?: AbortSignal): Promise<{ tree: string; conflicted: string[] }> {
  const merged = await git(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", fromHead, base], signal);
  if (merged.code !== 0 && merged.code !== 1) throw new CarryRefusal("merge-tree", merged.code);
  const [tree = "", ...conflicted] = merged.stdout.split("\0").filter((part) => part !== "");
  if (!HEAD.test(tree)) throw new CarryRefusal("merge-tree", merged.code);
  return { tree, conflicted };
}

async function changedBetween(git: Git, dir: string, from: string, to: string, signal?: AbortSignal): Promise<string[]> {
  const out = await must(git, dir, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to], signal);
  return out.split("\0").filter((path) => path !== "");
}

type RemergeFacts = Pick<RemergeResult, "base" | "headTree" | "remergeTree">;

function classify(touched: string[], generated: readonly string[], facts: RemergeFacts): RemergeResult {
  if (touched.length === 0) return { carries: true, rule: "remerge-empty", ...facts, paths: [], generatedPaths: [] };
  const isGenerated = compileGlobs(generated);
  const matched = touched.filter((path) => isGenerated(path));
  if (matched.length === touched.length) return { carries: true, rule: "remerge-generated-only", ...facts, paths: touched, generatedPaths: matched };
  return { carries: false, ...facts, paths: touched, generatedPaths: matched, reason: `the merge changed ${touched.length - matched.length} path(s) outside the declared generated files` };
}

async function probe(git: Git, dir: string, url: string, input: RemergeInput, signal?: AbortSignal): Promise<RemergeResult> {
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  const base = await mergedBase(git, dir, input, signal);
  if (typeof base !== "string") return base;
  const remerged = await remergeOf(git, dir, input.fromHead, base, signal);
  const headTree = await must(git, dir, ["rev-parse", `${input.head}^{tree}`], signal);
  const changed = await changedBetween(git, dir, remerged.tree, headTree, signal);
  const touched = [...new Set([...remerged.conflicted, ...changed])].sort();
  return classify(touched, input.generated, { base, headTree, remergeTree: remerged.tree });
}

/**
 * Does `head` carry what was decided at `fromHead`: is it `fromHead` plus one merge of the base whose remerge-diff is empty or
 * touches only declared generated files? Every failure, from bad input to a refused fetch, answers no with a reason.
 */
export async function remerge(raw: unknown, options: CarryOptions = {}): Promise<RemergeResult> {
  const parsed = RemergeInputSchema.safeParse(raw);
  if (!parsed.success) return { carries: false, reason: `invalid remerge input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
  const input = parsed.data;
  try {
    const dir = carryCacheDir(carryStateDir(options.stateDir), input.repo);
    const url = (options.remote ?? githubRemote)(input.repo);
    return await serialized(dir, () => probe(options.git ?? systemGit, dir, url, input, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return { carries: false, reason: reasonOf(error) };
  }
}

export function remergeRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(REMERGE_STEP, now, (input: unknown, signal) => remerge(input, { ...options, signal }));
}

/** The durable probe for one head; a replay reuses the recorded answer, so the ledger shows which paths the merge touched. */
export async function remergeStep(ctx: WorkflowContext, input: Omit<RemergeInput, "generated">): Promise<RemergeResult> {
  return step(ctx, `${REMERGE_STEP}:${input.head}`, { ...input, generated: generatedPathsFor(input.repo) }, RemergeResultSchema);
}

/** The authority fact for a remerge carry; only a carrying answer becomes one. */
export function remergeFact(fromHead: string, head: string, result: RemergeResult): CarryFact | undefined {
  const { rule, headTree, remergeTree, paths, generatedPaths } = result;
  if (!result.carries || !rule || !headTree || !remergeTree || !paths || !generatedPaths) return undefined;
  return { fromHead, head, headTree, mergeTree: remergeTree, rule, remergePaths: paths, generatedPaths };
}
