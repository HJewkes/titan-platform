import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyReports, type Classification } from "./classify.js";
import { CONFIG_PATH, parseFixProofConfig, type FixProofConfig } from "./config.js";
import { spawnExec, type Exec } from "./exec.js";
import { planFixProof, type FixProofPlan } from "./plan.js";
import { formatResultLine, toResult } from "./result-line.js";

/** Leaves headroom under the CI job's 20-minute timeout so the runner, not the job, reports the overrun. */
export const DEFAULT_BUDGET_MS = 18 * 60_000;
export const DEFAULT_BUILD = "pnpm build";
/** The vitest invocation; the runner appends the JSON reporter flags and the selected test paths. */
export const DEFAULT_COMMAND = "pnpm exec vitest run";
const CLEANUP_TIMEOUT_MS = 60_000;
const ZERO_SHA = "0".repeat(40);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RunOptions {
  /** The git checkout holding both commits. */
  repo: string;
  /** The merge base of the pull request, as a sha or ref. */
  base: string;
  /** The pull request head, as a sha or ref. */
  head: string;
  budgetMs?: number;
  exec?: Exec;
}

interface Context {
  repo: string;
  exec: Exec;
  deadline: number;
  tmp: string;
  trees: string[];
}

class RunError extends Error {}

function asSha(ref: string): string {
  return FULL_SHA.test(ref) ? ref : ZERO_SHA;
}

function remainingMs(ctx: Context): number {
  const left = ctx.deadline - Date.now();
  if (left <= 0) throw new RunError("timeout");
  return left;
}

async function call(ctx: Context, cwd: string, file: string, args: readonly string[]) {
  const result = await ctx.exec(file, args, { cwd, timeoutMs: remainingMs(ctx) });
  if (result.status === null) remainingMs(ctx);
  return result;
}

async function git(ctx: Context, args: readonly string[], what: string): Promise<string> {
  const result = await call(ctx, ctx.repo, "git", ["-c", "core.quotePath=false", ...args]);
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

async function planDiff(ctx: Context, base: string, head: string): Promise<FixProofPlan> {
  const nameStatus = await git(ctx, ["diff", "-M", "--name-status", base, head], "git diff");
  const planned = planFixProof({ nameStatus, baseConfig: await readConfig(ctx, base), headConfig: await readConfig(ctx, head) });
  if (!planned.ok) throw new RunError(planned.error);
  return planned.plan;
}

async function addTree(ctx: Context, name: string, sha: string): Promise<string> {
  const dir = path.join(ctx.tmp, name);
  await git(ctx, ["worktree", "add", "--detach", dir, sha], `creating the ${name} worktree`);
  ctx.trees.push(dir);
  return dir;
}

async function overlay(ctx: Context, tree: string, head: string, plan: FixProofPlan): Promise<void> {
  const result = await call(ctx, tree, "git", ["checkout", head, "--", ...plan.tests, ...plan.carried]);
  if (result.status !== 0) throw new RunError(`overlaying head files failed (exit ${result.status ?? "signal"})`);
  plan.overlayRemovals.forEach((file) => fs.rmSync(path.join(tree, file), { force: true }));
}

function sh(ctx: Context, tree: string, script: string, args: readonly string[]) {
  return call(ctx, tree, "sh", ["-c", `${script} "$@"`, "sh", ...args]);
}

async function shell(ctx: Context, tree: string, script: string, what: string): Promise<void> {
  const result = await sh(ctx, tree, script, []);
  if (result.status !== 0) throw new RunError(`${what} failed (exit ${result.status ?? "signal"})`);
}

async function prepare(ctx: Context, tree: string, side: string, config: FixProofConfig): Promise<void> {
  if (fs.existsSync(path.join(tree, "pnpm-lock.yaml"))) {
    await shell(ctx, tree, "pnpm install --frozen-lockfile", `${side}: install`);
  }
  await shell(ctx, tree, config.build ?? DEFAULT_BUILD, `${side}: build`);
}

async function runTests(ctx: Context, tree: string, plan: FixProofPlan, name: string): Promise<unknown> {
  const out = path.join(ctx.tmp, `${name}.json`);
  fs.rmSync(out, { force: true });
  const args = ["--reporter=json", "--outputFile", out, "--testTimeout", "30000", ...plan.tests];
  const result = await sh(ctx, tree, plan.config.command ?? DEFAULT_COMMAND, args);
  if (!fs.existsSync(out)) throw new RunError(`${name}: vitest wrote no report (exit ${result.status ?? "signal"})`);
  return JSON.parse(fs.readFileSync(out, "utf-8"));
}

async function classifyBoth(ctx: Context, plan: FixProofPlan, base: string, head: string): Promise<Classification> {
  const baseTree = await addTree(ctx, "base", base);
  await overlay(ctx, baseTree, head, plan);
  await prepare(ctx, baseTree, "base", plan.config);
  const headTree = await addTree(ctx, "head", head);
  await prepare(ctx, headTree, "head", plan.config);
  const headRun = { root: headTree, report: await runTests(ctx, headTree, plan, "head") };
  const classify = async (name: string) =>
    classifyReports({ selected: plan.tests, base: { root: baseTree, report: await runTests(ctx, baseTree, plan, name) }, head: headRun });
  const first = await classify("base");
  // A vacuous verdict may be a reproducer that flaked green once; one more base run rules that out.
  return first.verdict === "vacuous" ? classify("base-rerun") : first;
}

async function prove(ctx: Context, shas: { base: string; head: string }): Promise<string> {
  const plan = await planDiff(ctx, shas.base, shas.head);
  const classification: Classification =
    plan.tests.length === 0 ? { verdict: "no-tests", tests: [], files: [] } : await classifyBoth(ctx, plan, shas.base, shas.head);
  return formatResultLine(toResult({ head: shas.head, mergeBase: shas.base, plan, classification }));
}

/** A verdict error line for the given commits, standing in a zero sha for any that is not a full sha. */
export function errorLine(refs: { base: string; head: string }, error: string): string {
  const shas = { base: asSha(refs.base), head: asSha(refs.head) };
  const parsed = parseFixProofConfig(null);
  const config = parsed.ok ? parsed.config : { tests: [], carry: [] };
  const plan: FixProofPlan = { tests: [], carried: [], deletedTests: [], overlayRemovals: [], config, configEdited: false };
  const classification: Classification = { verdict: "error", tests: [], files: [], error };
  return formatResultLine(toResult({ head: shas.head, mergeBase: shas.base, plan, classification }));
}

async function cleanup(ctx: Context): Promise<void> {
  for (const tree of ctx.trees) {
    await ctx.exec("git", ["worktree", "remove", "--force", tree], { cwd: ctx.repo, timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
  }
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
  await ctx.exec("git", ["worktree", "prune"], { cwd: ctx.repo, timeoutMs: CLEANUP_TIMEOUT_MS }).catch(() => undefined);
}

/** Runs the head's tests over the merge base and at head and returns one fix-proof/v1 line; failures become a verdict error line, never a throw. */
export async function run(options: RunOptions): Promise<string> {
  const ctx: Context = {
    repo: path.resolve(options.repo),
    exec: options.exec ?? spawnExec,
    deadline: Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
    tmp: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-"))),
    trees: [],
  };
  const shas = { base: options.base, head: options.head };
  try {
    shas.base = await resolveCommit(ctx, options.base, "--base");
    shas.head = await resolveCommit(ctx, options.head, "--head");
    return await prove(ctx, shas);
  } catch (error) {
    return errorLine(shas, error instanceof Error ? error.message : String(error));
  } finally {
    await cleanup(ctx);
  }
}
