import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Classification } from "./classify.js";
import { CONFIG_PATH, parseFixProofConfig } from "./config.js";
import { spawnExec, type Exec } from "./exec.js";
import { planFixProof, type FixProofPlan } from "./plan.js";
import { formatResultLine, toResult } from "./result-line.js";

const CLEANUP_TIMEOUT_MS = 60_000;
const ZERO_SHA = "0".repeat(40);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The head side runs PR code in the shared checkout before the judge, so it could plant refs/replace objects, name files
// with pathspec magic, or write a core.fsmonitor or hook into .git; every git call ignores all of them so the trees read
// are the commits named and no program the PR names runs. A smudge filter's driver name is the PR's, so no -c stops it.
export const GIT_SAFETY = [
  "--no-replace-objects",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export interface Shas {
  base: string;
  head: string;
}

export interface Context {
  repo: string;
  exec: Exec;
  deadline: number;
  tmp: string;
  trees: string[];
}

export class RunError extends Error {}

function asSha(ref: string): string {
  return FULL_SHA.test(ref) ? ref : ZERO_SHA;
}

function remainingMs(ctx: Context): number {
  const left = ctx.deadline - Date.now();
  if (left <= 0) throw new RunError("timeout");
  return left;
}

export async function call(ctx: Context, cwd: string, file: string, args: readonly string[]) {
  const result = await ctx.exec(file, args, { cwd, timeoutMs: remainingMs(ctx) });
  if (result.status === null) remainingMs(ctx);
  return result;
}

export async function git(ctx: Context, args: readonly string[], what: string): Promise<string> {
  const result = await call(ctx, ctx.repo, "git", [...GIT_SAFETY, "-c", "core.quotePath=false", ...args]);
  if (result.status !== 0) throw new RunError(`${what} failed (exit ${result.status ?? "signal"})`);
  return result.stdout;
}

async function resolveCommit(ctx: Context, ref: string, flag: string): Promise<string> {
  const sha = (await git(ctx, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], `resolving ${flag}`)).trim();
  if (!FULL_SHA.test(sha)) throw new RunError(`resolving ${flag} gave no full sha`);
  return sha;
}

async function readConfig(ctx: Context, sha: string): Promise<string | null> {
  const listed = await git(ctx, ["ls-tree", "--name-only", sha, "--", CONFIG_PATH], "listing the config");
  if (listed.trim() === "") return null;
  return git(ctx, ["show", `${sha}:${CONFIG_PATH}`], "reading the config");
}

/** The plan from git alone, so each side and the judge derive the same test set without trusting one another. */
export async function planDiff(ctx: Context, shas: Shas): Promise<FixProofPlan> {
  const nameStatus = await git(ctx, ["diff", "--no-ext-diff", "--no-textconv", "-M", "--name-status", shas.base, shas.head], "git diff");
  const planned = planFixProof({ nameStatus, baseConfig: await readConfig(ctx, shas.base), headConfig: await readConfig(ctx, shas.head) });
  if (!planned.ok) throw new RunError(planned.error);
  return planned.plan;
}

/** A verdict error line for the given commits, standing in a zero sha for any that is not a full sha. */
export function errorLine(refs: Shas, error: string): string {
  const shas = { base: asSha(refs.base), head: asSha(refs.head) };
  const parsed = parseFixProofConfig(null);
  const config = parsed.ok ? parsed.config : { tests: [], carry: [], runtime: [] };
  const plan: FixProofPlan = { tests: [], carried: [], deletedTests: [], overlayRemovals: [], mutations: [], source: [], config, configEdited: false };
  const classification: Classification = { verdict: "error", tests: [], files: [], error };
  return formatResultLine(toResult({ head: shas.head, mergeBase: shas.base, plan, classification }));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanup(ctx: Context): Promise<void> {
  for (const tree of ctx.trees) {
    await ctx.exec("git", [...GIT_SAFETY, "worktree", "remove", "--force", tree], { cwd: ctx.repo, timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  }
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
  if (ctx.trees.length > 0) {
    await ctx.exec("git", [...GIT_SAFETY, "worktree", "prune"], { cwd: ctx.repo, timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  }
}

export interface ContextOptions {
  repo: string;
  base: string;
  head: string;
  budgetMs: number;
  exec?: Exec;
}

/**
 * Resolves both commits and runs body with a fresh context, always removing its worktrees and temp dir afterwards.
 * A throw reaches onError with whichever commits resolved, so failures become a verdict, never an exception.
 */
export async function withContext<T>(
  options: ContextOptions,
  body: (ctx: Context, shas: Shas) => Promise<T>,
  onError: (shas: Shas, error: string) => T,
): Promise<T> {
  const ctx: Context = {
    repo: path.resolve(options.repo),
    exec: options.exec ?? spawnExec,
    deadline: Date.now() + options.budgetMs,
    tmp: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-"))),
    trees: [],
  };
  const shas = { base: options.base, head: options.head };
  try {
    shas.base = await resolveCommit(ctx, options.base, "--base");
    shas.head = await resolveCommit(ctx, options.head, "--head");
    return await body(ctx, { ...shas });
  } catch (error) {
    return onError(shas, messageOf(error));
  } finally {
    await cleanup(ctx);
  }
}
