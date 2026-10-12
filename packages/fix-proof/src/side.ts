import * as fs from "node:fs";
import * as path from "node:path";
import type { FixProofConfig } from "./config.js";
import { call, GIT_SAFETY, messageOf, planDiff, RunError, withContext, type Context, type Shas } from "./context.js";
import type { Exec } from "./exec.js";
import { relativeToRoot } from "./paths.js";
import type { FixProofPlan } from "./plan.js";
import { assertSandboxUser, sandboxCommand } from "./sandbox.js";
import { encodeError, encodeReport } from "./transport.js";

/** Leaves headroom under the CI job's 20-minute timeout so the runner, not the job, reports the overrun. */
export const DEFAULT_BUDGET_MS = 18 * 60_000;
export const DEFAULT_BUILD = "pnpm build";
/** The vitest invocation; the runner appends the JSON reporter flags and the selected test paths. */
export const DEFAULT_COMMAND = "pnpm exec vitest run";
const TEARDOWN_TIMEOUT_MS = 60_000;

export type Side = "base" | "head";

/** The reports each side writes, as `<name>.report` in its out dir; the base runs twice so a flaky reproducer can be ruled out. */
export const SIDE_REPORTS: Readonly<Record<Side, readonly string[]>> = { base: ["base", "base-rerun"], head: ["head"] };

export interface ExecSideOptions {
  /** The git checkout holding both commits. */
  repo: string;
  /** The merge base of the pull request, as a sha or ref. */
  base: string;
  /** The pull request head, as a sha or ref. */
  head: string;
  side: Side;
  /** Directory the encoded reports are written to. */
  out: string;
  budgetMs?: number;
  exec?: Exec;
  /**
   * Runs each base-side vitest call as this user in a fresh PID namespace through `sudo -n`, so nothing the head's test
   * or carried files start outlives the run or can write the runner's files. The head side ignores it.
   */
  sandboxUser?: string;
}

async function addTree(ctx: Context, name: string, sha: string): Promise<string> {
  const dir = path.join(ctx.tmp, name);
  const result = await call(ctx, ctx.repo, "git", [...GIT_SAFETY, "worktree", "add", "--detach", dir, sha]);
  if (result.status !== 0) throw new RunError(`creating the ${name} worktree failed (exit ${result.status ?? "signal"})`);
  ctx.trees.push(dir);
  return dir;
}

async function overlay(ctx: Context, tree: string, head: string, plan: FixProofPlan): Promise<void> {
  const result = await call(ctx, tree, "git", [...GIT_SAFETY, "checkout", head, "--", ...plan.tests, ...plan.carried]);
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

async function prepare(ctx: Context, tree: string, side: Side, config: FixProofConfig): Promise<void> {
  if (fs.existsSync(path.join(tree, "pnpm-lock.yaml"))) {
    await shell(ctx, tree, "pnpm install --frozen-lockfile", `${side}: install`);
  }
  await shell(ctx, tree, config.build ?? DEFAULT_BUILD, `${side}: build`);
}

// Repo-relative names let the judge read the report without knowing where this side's tree was.
function relativeNames(report: unknown, root: string): unknown {
  if (!isRecord(report) || !Array.isArray(report.testResults)) return report;
  const files = report.testResults.flatMap((file: unknown) => {
    if (!isRecord(file) || typeof file.name !== "string") return [];
    const relative = relativeToRoot(file.name, root);
    return relative === null ? [] : [{ ...file, name: relative }];
  });
  return { ...report, testResults: files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The sandbox user owns the output dir, so the file there could be a symlink to a forged report or a FIFO that blocks.
function readRegularFile(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, "utf-8") : null;
  } finally {
    fs.closeSync(fd);
  }
}

async function sudo(ctx: Context, args: readonly string[]): Promise<void> {
  const result = await call(ctx, ctx.tmp, "sudo", ["-n", "--", ...args]);
  if (result.status !== 0) throw new RunError(`base: sandbox setup failed (sudo ${args[0]} exit ${result.status ?? "signal"})`);
}

function vitest(ctx: Context, tree: string, script: string, args: readonly string[], sandboxUser: string | undefined) {
  if (sandboxUser === undefined) return sh(ctx, tree, script, args);
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tree, CI: "1" };
  const command = sandboxCommand(sandboxUser, ctx.deadline - Date.now(), env, script, args);
  return call(ctx, tree, command.file, command.args);
}

async function runTests(ctx: Context, tree: string, plan: FixProofPlan, name: string, sandboxUser?: string): Promise<string> {
  // A fresh dir per run, handed to the sandbox only now, so an earlier run cannot plant this run's report.
  const dir = path.join(ctx.tmp, `${name}-out`);
  fs.mkdirSync(dir);
  if (sandboxUser !== undefined) await sudo(ctx, ["chown", `${sandboxUser}:`, dir]);
  const out = path.join(dir, `${name}.json`);
  const args = ["--reporter=json", "--outputFile", out, "--testTimeout", "30000", ...plan.tests];
  const result = await vitest(ctx, tree, plan.config.command ?? DEFAULT_COMMAND, args, sandboxUser);
  const json = readRegularFile(out);
  if (json === null) throw new RunError(`${name}: vitest wrote no report (exit ${result.status ?? "signal"})`);
  return encodeReport(relativeNames(JSON.parse(json), tree));
}

function runnerOwner(): string {
  if (process.getuid === undefined || process.getgid === undefined) throw new RunError("base: sandbox setup failed (no uid on this platform)");
  return `${process.getuid()}:${process.getgid()}`;
}

/**
 * Hands the tree's directories to the sandbox user for body, then everything under ctx.tmp back to the runner so cleanup
 * can remove it. Only directories: pnpm hardlinks node_modules files to its store, which the runner keeps using.
 */
async function withSandbox<T>(ctx: Context, tree: string, user: string, body: () => Promise<T>): Promise<T> {
  assertSandboxUser(user);
  const owner = runnerOwner();
  fs.chmodSync(ctx.tmp, 0o711);
  try {
    await sudo(ctx, ["find", tree, "-type", "d", "-exec", "chown", `${user}:`, "{}", "+"]);
    return await body();
  } finally {
    await ctx.exec("sudo", ["-n", "--", "chown", "-R", owner, ctx.tmp], { cwd: ctx.tmp, timeoutMs: TEARDOWN_TIMEOUT_MS });
  }
}

async function runSide(ctx: Context, shas: Shas, side: Side, sandboxUser?: string): Promise<string[]> {
  const plan = await planDiff(ctx, shas);
  if (plan.tests.length === 0) return SIDE_REPORTS[side].map(() => encodeError("no tests planned"));
  const tree = await addTree(ctx, side, shas[side]);
  // The base builds before any head file lands in its tree, so nothing the PR carries runs during its install or build.
  await prepare(ctx, tree, side, plan.config);
  if (side === "head") return [await runTests(ctx, tree, plan, "head")];
  await overlay(ctx, tree, shas.head, plan);
  const both = async () => [await runTests(ctx, tree, plan, "base", sandboxUser), await runTests(ctx, tree, plan, "base-rerun", sandboxUser)];
  return sandboxUser === undefined ? both() : withSandbox(ctx, tree, sandboxUser, both);
}

/** Builds and tests one side of the proof and writes its encoded reports to out; a failure writes error markers, never throws. */
export async function execSide(options: ExecSideOptions): Promise<void> {
  const names = SIDE_REPORTS[options.side];
  const reports = await withContext(
    { ...options, budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS },
    (ctx, shas) => runSide(ctx, shas, options.side, options.sandboxUser),
    (_shas, error) => names.map(() => encodeError(error)),
  ).catch((error: unknown) => names.map(() => encodeError(`${options.side}: cleanup failed: ${messageOf(error)}`)));
  try {
    fs.mkdirSync(options.out, { recursive: true });
    names.forEach((name, index) => fs.writeFileSync(path.join(options.out, `${name}.report`), reports[index] ?? ""));
  } catch {
    // The judge reads an absent report as a named error verdict, so swallowing a write failure still fails closed.
  }
}
