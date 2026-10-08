import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { resolveDbPath } from "../config.js";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { errorClass } from "./error-class.js";
import { isRepoKey } from "./seats.js";

export const CARRY_STEP = "sh-carry";
const GIT_TIMEOUT_MS = 10 * 60_000;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git against one bare repository; resolves with the exit code instead of rejecting. */
export type Git = (gitDir: string, args: readonly string[], signal?: AbortSignal) => Promise<GitResult>;

/** `fromHead` is the head whose MERGE would be carried, `head` the new green head. */
export type CarryInput = z.infer<typeof CarryInputSchema>;

/** `base` is the head's second parent, the base commit an update merged in. */
export type CarryResult = z.infer<typeof CarryResultSchema>;

export interface CarryOptions {
  /** Holds `git-cache/<owner>/<name>.git`; absent means the bound state dir, else the configured database's directory. */
  stateDir?: string;
  /** The fetch URL for `repo`; absent means GitHub over https. */
  remote?: (repo: string) => string;
  git?: Git;
  signal?: AbortSignal;
}

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const BranchName = z.string().regex(/^[A-Za-z0-9._/-]+$/).refine((name) => !name.startsWith("-") && !name.includes(".."), "must be a plain branch name");
const CarryInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, fromHead: Sha, head: Sha });
export const CarryResultSchema = z.object({ equal: z.boolean(), base: z.string().optional(), headTree: z.string().optional(), mergeTree: z.string().optional(), reason: z.string().optional() });

/** Fails the probe with a reason; never leaves `carry`. */
/** A git command that exited non-zero; only the subcommand and exit code are kept, since stderr can echo a remote URL or credential. */
class CarryRefusal extends Error {
  constructor(readonly command: string, readonly code: number) {
    super(`git ${command} exited ${code}`);
    this.name = "CarryRefusal";
  }
}

/** Never prompts and never reads a user credential helper; GitHub auth comes from `gh`. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "!gh auth git-credential",
};

export const systemGit: Git = (gitDir, args, signal) =>
  new Promise((resolve) => {
    const options = { encoding: "utf8" as const, timeout: GIT_TIMEOUT_MS, signal, env: { ...process.env, ...GIT_ENV } };
    execFile("git", ["--git-dir", gitDir, ...args], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 128) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });

let boundStateDir: string | undefined;

/** The server binds its state dir so the cache sits beside its database; the returned function unbinds it. */
export function bindCarryStateDir(stateDir: string): () => void {
  boundStateDir = stateDir;
  return () => {
    if (boundStateDir === stateDir) boundStateDir = undefined;
  };
}

export function carryCacheDir(stateDir: string, repo: string): string {
  const [owner = "", name = ""] = repo.toLowerCase().split("/");
  return join(stateDir, "git-cache", owner, `${name}.git`);
}

const githubRemote = (repo: string): string => `https://github.com/${repo}.git`;
const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

async function must(git: Git, dir: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const result = await git(dir, args, signal);
  if (result.code !== 0) throw new CarryRefusal(args[0] ?? "", result.code);
  return result.stdout.trim();
}

async function isAncestor(git: Git, dir: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(dir, ["merge-base", "--is-ancestor", ancestor, descendant], signal);
  if (result.code > 1) throw new CarryRefusal("merge-base", result.code);
  return result.code === 0;
}

async function ensureCache(git: Git, dir: string, signal?: AbortSignal): Promise<void> {
  if (existsSync(join(dir, "HEAD"))) return;
  mkdirSync(dirname(dir), { recursive: true });
  await must(git, dir, ["init", "--bare", "--quiet"], signal);
}

const remoteBase = (baseRef: string): string => `refs/remotes/origin/${baseRef}`;

function fetchArgs(url: string, input: CarryInput): string[] {
  return ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, input.fromHead, input.head, `+refs/heads/${input.baseRef}:${remoteBase(input.baseRef)}`];
}

/** The second parent of a two-parent head, or a reason it is not one. */
async function secondParent(git: Git, dir: string, head: string, signal?: AbortSignal): Promise<string | CarryResult> {
  const parents = (await must(git, dir, ["rev-list", "--parents", "-n", "1", head], signal)).split(" ").slice(1);
  const base = parents[1];
  if (parents.length !== 2 || base === undefined) return { equal: false, reason: `${head} has ${parents.length} parents, not the two of a merge update` };
  return base;
}

/** Equal only when the head is exactly the reviewed head merged cleanly onto a commit of the base branch. */
async function compareTrees(git: Git, dir: string, input: CarryInput, base: string, signal?: AbortSignal): Promise<CarryResult> {
  if (!(await isAncestor(git, dir, input.fromHead, input.head, signal))) return { equal: false, base, reason: `${input.fromHead} is not an ancestor of ${input.head}` };
  if (!(await isAncestor(git, dir, base, remoteBase(input.baseRef), signal))) return { equal: false, base, reason: `second parent ${base} is not on ${input.baseRef}` };
  const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", base, input.fromHead], signal);
  if (merged.code === 1) return { equal: false, base, reason: `${input.fromHead} conflicts with ${base}` };
  if (merged.code !== 0) throw new CarryRefusal("merge-tree", merged.code);
  const mergeTree = firstLine(merged.stdout);
  const headTree = await must(git, dir, ["rev-parse", `${input.head}^{tree}`], signal);
  if (mergeTree === headTree) return { equal: true, base, headTree, mergeTree };
  return { equal: false, base, headTree, mergeTree, reason: `tree of ${input.head} differs from ${input.fromHead} merged onto ${base}` };
}

async function probe(git: Git, dir: string, url: string, input: CarryInput, signal?: AbortSignal): Promise<CarryResult> {
  await ensureCache(git, dir, signal);
  await must(git, dir, fetchArgs(url, input), signal);
  const base = await secondParent(git, dir, input.head, signal);
  return typeof base === "string" ? compareTrees(git, dir, input, base, signal) : base;
}

const queues = new Map<string, Promise<unknown>>();

/** One probe per cache at a time, so two runs never race `git init` or the base ref update. */
function serialized<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(dir) ?? Promise.resolve()).then(task, task);
  const settled = next.catch(() => undefined);
  queues.set(dir, settled);
  void settled.then(() => queues.get(dir) === settled && queues.delete(dir));
  return next;
}

/** A fixed-vocabulary reason: the reason is a stored step output that can reach a public PR, so no error text goes into it. */
const reasonOf = (error: unknown): string => (error instanceof CarryRefusal ? `git ${error.command} exited ${error.code}` : `carry probe failed: ${errorClass(error)}`);

const issuesOf = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

/** Runs `task` on the repo's cache, one at a time; a failure answers through `refused`, never a throw. */
async function inCache<T>(repo: string, options: CarryOptions, task: (git: Git, dir: string, url: string) => Promise<T>, refused: (reason: string) => T): Promise<T> {
  try {
    const stateDir = options.stateDir ?? boundStateDir ?? dirname(resolveDbPath({ env: process.env }));
    const dir = carryCacheDir(stateDir, repo);
    const url = (options.remote ?? githubRemote)(repo);
    return await serialized(dir, () => task(options.git ?? systemGit, dir, url));
  } catch (error) {
    options.signal?.throwIfAborted();
    return refused(reasonOf(error));
  }
}

/** Does `head` carry the review of `fromHead`? Every failure, from bad input to a refused fetch, answers not equal with a reason. */
export async function carry(raw: unknown, options: CarryOptions = {}): Promise<CarryResult> {
  const parsed = CarryInputSchema.safeParse(raw);
  if (!parsed.success) return { equal: false, reason: `invalid carry input: ${issuesOf(parsed.error)}` };
  const input = parsed.data;
  return inCache(input.repo, options, (git, dir, url) => probe(git, dir, url, input, options.signal), (reason) => ({ equal: false, reason }));
}

const MergeTreeInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, headSha: Sha });

/**
 * `git merge-tree` of the head onto the base tip as fetched now: the merge GitHub's own mergeability read computes. It
 * answers `clean`, `conflict`, or `unread: <why>` from a fixed vocabulary, since the answer can reach a public PR.
 */
export async function localMergeTree(raw: unknown, options: CarryOptions = {}): Promise<string> {
  const parsed = MergeTreeInputSchema.safeParse(raw);
  if (!parsed.success) return `unread: invalid input: ${issuesOf(parsed.error)}`;
  const { repo, baseRef, headSha } = parsed.data;
  const merge = async (git: Git, dir: string, url: string): Promise<string> => {
    await ensureCache(git, dir, options.signal);
    await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, headSha, `+refs/heads/${baseRef}:${remoteBase(baseRef)}`], options.signal);
    const merged = await git(dir, ["merge-tree", "--write-tree", "--no-messages", remoteBase(baseRef), headSha], options.signal);
    if (merged.code > 1) throw new CarryRefusal("merge-tree", merged.code);
    return merged.code === 0 ? "clean" : "conflict";
  };
  return inCache(repo, options, merge, (reason) => `unread: ${reason}`);
}

export function carryRoute(now: () => number, options: Omit<CarryOptions, "signal"> = {}): StepRoute {
  return codeRoute(CARRY_STEP, now, (input: unknown, signal) => carry(input, { ...options, signal }));
}

/** The durable probe for one head; a replay reuses the recorded answer, so the ledger shows why a review was skipped. */
export async function carryStep(ctx: WorkflowContext, input: CarryInput): Promise<CarryResult> {
  return step(ctx, `${CARRY_STEP}:${input.head}`, input, CarryResultSchema);
}
