import type { CarryFact } from "@titan-design/authority";
import { compileGlobs } from "@titan-design/fix-proof";
import type { GitHubPort } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { readBaseRequiredChecks } from "../required-checks.js";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { changedPathsBetween } from "./changed-paths.js";
import generatedFreshnessJson from "./generated-freshness.json" with { type: "json" };
import generatedPathsJson from "./generated-paths.json" with { type: "json" };
import { isRepoKey } from "./seats.js";
import {
  BranchName,
  CarryRefusal,
  cacheFor,
  ensureCache,
  fetchArgs,
  isAncestor,
  must,
  reasonOf,
  remoteBase,
  serialized,
  type CacheHandle,
  type CarryOptions,
  type Git,
} from "./tree-carry.js";

export const REMERGE_STEP = "sh-remerge";

/** Which probe carried a verdict or an approval to a new head; the evidence and the review check name it. */
export type CarryRule = "tree-equal" | "remerge-empty" | "remerge-generated-only";

/**
 * Per repo, lowercased, the globs of files a tool rewrites whole; a merge that touched only these resolved nothing a reviewer reads.
 * A file a person edits, even one a tool also reads or stamps once, never belongs here: its resolution needs a review.
 */
const GENERATED_PATHS: Readonly<Record<string, readonly string[]>> = generatedPathsJson;

export function generatedPathsFor(repo: string): string[] {
  return [...(GENERATED_PATHS[repo.toLowerCase()] ?? [])];
}

/**
 * Per repo, lowercased, the required check context whose job content-diffs the generated files (capabilities:check, docs:build).
 * A generated-only merge carries only while the base requires it; a repo naming none never carries one.
 */
const FRESHNESS_CONTEXTS: Readonly<Record<string, string>> = generatedFreshnessJson;

export function freshnessContextFor(repo: string): string | undefined {
  return FRESHNESS_CONTEXTS[repo.toLowerCase()];
}

/** The base's required contexts, or undefined when they cannot be read. */
export type RequiredContextsReader = (repo: string, baseRef: string) => Promise<readonly string[] | undefined>;

/** Reads rulesets, then classic protection; a failed or malformed read is undefined, never an empty list. */
export function requiredContextsOf(port: GitHubPort): RequiredContextsReader {
  return async (repo, baseRef) => {
    const read = await readBaseRequiredChecks(port, repo, baseRef);
    return read.readable ? read.checks.contexts : undefined;
  };
}

type RemergeOptions = CarryOptions & { requiredContexts?: RequiredContextsReader };

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const RemergeInputSchema = z.object({
  repo: z.string().refine(isRepoKey, "must be owner/repo"),
  baseRef: BranchName,
  fromHead: Sha,
  head: Sha,
  generated: z.array(z.string().min(1)),
  freshnessContext: z.string().min(1).optional(),
});
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

type RemergeFacts = Pick<RemergeResult, "base" | "headTree" | "remergeTree">;

function classify(touched: string[], generated: readonly string[], facts: RemergeFacts): RemergeResult {
  if (touched.length === 0) return { carries: true, rule: "remerge-empty", ...facts, paths: [], generatedPaths: [] };
  const isGenerated = compileGlobs(generated);
  const matched = touched.filter((path) => isGenerated(path));
  if (matched.length === touched.length) return { carries: true, rule: "remerge-generated-only", ...facts, paths: touched, generatedPaths: matched };
  return { carries: false, ...facts, paths: touched, generatedPaths: matched, reason: `the merge changed ${touched.length - matched.length} path(s) outside the declared generated files` };
}

/** A generated-only answer stands only while the base requires the check that content-diffs those files; otherwise it re-gates. */
async function requireFreshness(result: RemergeResult, input: RemergeInput, options: RemergeOptions): Promise<RemergeResult> {
  if (result.rule !== "remerge-generated-only") return result;
  const { base, headTree, remergeTree, paths, generatedPaths } = result;
  const refuse = (reason: string): RemergeResult => ({ carries: false, base, headTree, remergeTree, paths, generatedPaths, reason });
  const context = input.freshnessContext;
  if (context === undefined) return refuse(`${input.repo} declares no freshness context for its generated files`);
  const required = await options.requiredContexts?.(input.repo, input.baseRef);
  if (required === undefined) return refuse(`the required checks of ${input.repo}@${input.baseRef} cannot be read, so ${context} is not known to be required`);
  if (!required.includes(context)) return refuse(`${context} is not a required check of ${input.repo}@${input.baseRef}, so nothing content-diffs the generated files`);
  return result;
}

async function probe(cache: CacheHandle, input: RemergeInput, signal?: AbortSignal): Promise<RemergeResult> {
  const { git, dir, url } = cache;
  await ensureCache(cache, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  const base = await mergedBase(git, dir, input, signal);
  if (typeof base !== "string") return base;
  const remerged = await remergeOf(git, dir, input.fromHead, base, signal);
  const headTree = await must(git, dir, ["rev-parse", `${input.head}^{tree}`], signal);
  const changed = await changedPathsBetween(git, dir, remerged.tree, headTree, signal);
  const touched = [...new Set([...remerged.conflicted, ...changed])].sort();
  return classify(touched, input.generated, { base, headTree, remergeTree: remerged.tree });
}

/**
 * Does `head` carry what was decided at `fromHead`: is it `fromHead` plus one merge of the base whose remerge-diff is empty or
 * touches only declared generated files? Every failure, from bad input to a refused fetch, answers no with a reason.
 */
export async function remerge(raw: unknown, options: RemergeOptions): Promise<RemergeResult> {
  const parsed = RemergeInputSchema.safeParse(raw);
  if (!parsed.success) return { carries: false, reason: `invalid remerge input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
  const input = parsed.data;
  try {
    const cache = cacheFor(input.repo, options);
    const probed = await serialized(cache.dir, () => probe(cache, input, options.signal));
    return await requireFreshness(probed, input, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    return { carries: false, reason: reasonOf(error) };
  }
}

export function remergeRoute(now: () => number, options: Omit<RemergeOptions, "signal">): StepRoute {
  return codeRoute(REMERGE_STEP, now, (input: unknown, signal) => remerge(input, { ...options, signal }));
}

const freshnessInput = (repo: string): { freshnessContext?: string } => {
  const freshnessContext = freshnessContextFor(repo);
  return freshnessContext === undefined ? {} : { freshnessContext };
};

/** The durable probe for one head; a replay reuses the recorded answer, so the ledger shows which paths the merge touched. */
export async function remergeStep(ctx: WorkflowContext, input: Omit<RemergeInput, "generated" | "freshnessContext">): Promise<RemergeResult> {
  return step(ctx, `${REMERGE_STEP}:${input.head}`, { ...input, generated: generatedPathsFor(input.repo), ...freshnessInput(input.repo) }, RemergeResultSchema);
}

/** The authority fact for a remerge carry; only a carrying answer becomes one. */
export function remergeFact(fromHead: string, head: string, result: RemergeResult): CarryFact | undefined {
  const { rule, headTree, remergeTree, paths, generatedPaths } = result;
  if (!result.carries || !rule || !headTree || !remergeTree || !paths || !generatedPaths) return undefined;
  return { fromHead, head, headTree, mergeTree: remergeTree, rule, remergePaths: paths, generatedPaths };
}
