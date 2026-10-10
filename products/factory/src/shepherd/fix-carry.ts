import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { isRepoKey } from "./seats.js";
import {
  BranchName,
  CarryRefusal,
  carryCacheDir,
  carryStateDir,
  ensureCache,
  fetchArgs,
  githubRemote,
  must,
  reasonOf,
  remoteBase,
  serialized,
  systemGit,
  type CarryOptions,
  type Git,
} from "./tree-carry.js";

/** Under the approval-carry family so the step reads as awaiting approval; its own route is the longer match, so the approval record's passthrough never takes it. */
export const FIX_CARRY_STEP = "sh-approval-carry:fix";

/** What an owner's merge answer may follow across a fix push: the fix's own diff, past what the base merge brought. One place, so a policy change is one edit. */
export const SMALL_FIX_LIMITS = { maxChangedLines: 40, maxFiles: 3 } as const;

/** `merge-up` is a head whose tree is the approved head merged with the base; `small-fix` adds a small diff to a file the PR already had. */
export type FixCarryRule = "merge-up" | "small-fix";

const LOCKFILES: ReadonlySet<string> = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-workspace.yaml"]);
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies", "overrides", "resolutions", "pnpm", "packageManager"];

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const FixInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, fromHead: Sha, head: Sha });
export type FixCarryInput = z.infer<typeof FixInputSchema>;

const FixResultSchema = z.object({
  carries: z.boolean(),
  rule: z.enum(["merge-up", "small-fix"]).optional(),
  /** The base commit of the head's own history the approved head was merged with. */
  base: z.string().optional(),
  headTree: z.string().optional(),
  /** The tree of `git merge-tree` of the approved head and `base`. */
  mergeTree: z.string().optional(),
  changedLines: z.number().optional(),
  paths: z.array(z.string()).optional(),
  reason: z.string().optional(),
});
export type FixCarryResult = z.infer<typeof FixResultSchema>;

const refuse = (reason: string, rest: Partial<FixCarryResult> = {}): FixCarryResult => ({ ...rest, carries: false, reason });
const lines = (out: string): string[] => out.split("\0").filter((part) => part !== "");

/** Every changed path with its status, renames split into an add and a delete so they never read as a modification; a mode change reads as `T`. */
async function statuses(git: Git, dir: string, from: string, to: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const parts = lines(await must(git, dir, ["diff-tree", "-r", "--no-renames", "--raw", "-z", from, to], signal));
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, , , status = ""] = parts[i]!.slice(1).split(" ");
    out.set(parts[i + 1]!, oldMode === newMode ? status : "T");
  }
  return out;
}

/** Added plus deleted lines; undefined when a changed file is binary, which has no line count. */
async function changedLines(git: Git, dir: string, from: string, to: string, signal?: AbortSignal): Promise<number | undefined> {
  const rows = lines(await must(git, dir, ["diff-tree", "-r", "--no-renames", "--numstat", "-z", from, to], signal));
  let total = 0;
  for (const row of rows) {
    const [added, deleted] = row.split("\t");
    if (!/^\d+$/.test(added ?? "") || !/^\d+$/.test(deleted ?? "")) return undefined;
    total += Number(added) + Number(deleted);
  }
  return total;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

async function dependencyFields(git: Git, dir: string, rev: string, path: string, signal?: AbortSignal): Promise<string> {
  const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(await must(git, dir, ["show", `${rev}:${path}`], signal)));
  return JSON.stringify(DEPENDENCY_FIELDS.map((field) => parsed[field] ?? null));
}

/** A reason this path may not ride a carried answer, or undefined. A package.json is judged on its dependency fields alone. */
async function forbidden(git: Git, dir: string, merged: string, head: string, path: string, signal?: AbortSignal): Promise<string | undefined> {
  if (path.startsWith(".github/")) return "the fix changes .github";
  if (LOCKFILES.has(basename(path))) return "the fix changes a lockfile";
  if (basename(path) !== "package.json") return undefined;
  return (await dependencyFields(git, dir, merged, path, signal)) === (await dependencyFields(git, dir, head, path, signal)) ? undefined : "the fix changes package.json dependencies";
}

/** The paths the PR itself changed at `fromHead`, measured from where it left the base commit the new head merged. */
async function prFiles(git: Git, dir: string, input: FixCarryInput, base: string, signal?: AbortSignal): Promise<Set<string>> {
  const fork = await must(git, dir, ["merge-base", input.fromHead, base], signal);
  return new Set((await statuses(git, dir, fork, input.fromHead, signal)).keys());
}

async function judge(git: Git, dir: string, input: FixCarryInput, merged: { base: string; mergeTree: string; headTree: string }, signal?: AbortSignal): Promise<FixCarryResult> {
  const facts = { base: merged.base, headTree: merged.headTree, mergeTree: merged.mergeTree };
  if (merged.headTree === merged.mergeTree) return { ...facts, carries: true, rule: "merge-up", changedLines: 0, paths: [] };
  const changed = await statuses(git, dir, merged.mergeTree, input.head, signal);
  const paths = [...changed.keys()].sort();
  const refused = (reason: string) => refuse(reason, { ...facts, paths });
  if (paths.length > SMALL_FIX_LIMITS.maxFiles) return refused(`the fix touches ${paths.length} files, over ${SMALL_FIX_LIMITS.maxFiles}`);
  if ([...changed.values()].some((status) => status !== "M")) return refused("the fix adds, deletes, retypes or changes the mode of a file");
  const existing = await prFiles(git, dir, input, merged.base, signal);
  const outside = paths.find((path) => !existing.has(path));
  if (outside !== undefined) return refused("the fix touches a file the PR did not change at the approved head");
  for (const path of paths) {
    const why = await forbidden(git, dir, merged.mergeTree, input.head, path, signal);
    if (why) return refused(why);
  }
  const total = await changedLines(git, dir, merged.mergeTree, input.head, signal);
  if (total === undefined) return refused("the fix changes a binary file");
  if (total > SMALL_FIX_LIMITS.maxChangedLines) return refused(`the fix changes ${total} lines, over ${SMALL_FIX_LIMITS.maxChangedLines}`);
  return { ...facts, carries: true, rule: "small-fix", changedLines: total, paths };
}

async function probe(git: Git, dir: string, url: string, input: FixCarryInput, signal?: AbortSignal): Promise<FixCarryResult> {
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  const base = await must(git, dir, ["merge-base", input.head, remoteBase(input.baseRef)], signal);
  const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", input.fromHead, base], signal);
  if (merged.code === 1) return refuse(`${input.fromHead} conflicts with ${base}`, { base });
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const mergeTree = merged.stdout.trim().split("\n")[0] ?? "";
  const headTree = await must(git, dir, ["rev-parse", `${input.head}^{tree}`], signal);
  return judge(git, dir, input, { base, mergeTree, headTree }, signal);
}

/**
 * Does `head` differ from the approved `fromHead` merged with the base commit `head` already contains by nothing (a clean
 * merge-up) or by a small fix? Any failure, from bad input to a refused fetch or an unreadable file, answers no with a reason.
 */
export async function fixCarry(raw: unknown, options: CarryOptions = {}): Promise<FixCarryResult> {
  const parsed = FixInputSchema.safeParse(raw);
  if (!parsed.success) return refuse(`invalid fix-carry input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
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

export function fixCarryRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(FIX_CARRY_STEP, now, (input: unknown, signal) => fixCarry(input, { ...options, signal }));
}

/** The durable probe for one head; a replay reuses the recorded answer, so the ledger shows the diff the owner's answer followed. */
export async function fixCarryStep(ctx: WorkflowContext, input: FixCarryInput): Promise<FixCarryResult> {
  return step(ctx, `${FIX_CARRY_STEP}:${input.head}`, input, FixResultSchema);
}
