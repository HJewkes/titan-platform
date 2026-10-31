import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import type { FixProofConfig } from "./config.js";
import { call, GIT_SAFETY, messageOf, planDiff, RunError, withContext, type Context, type Shas } from "./context.js";
import type { Exec } from "./exec.js";
import { relativeToRoot } from "./paths.js";
import type { FixProofPlan } from "./plan.js";
import { assertSandboxUser, sandboxCommand, sandboxEnv } from "./sandbox.js";
import { toolchainOf } from "./toolchain.js";
import { encodeError, encodeReport } from "./transport.js";

/** Leaves headroom under the CI job's 20-minute timeout so the runner, not the job, reports the overrun. */
export const DEFAULT_BUDGET_MS = 18 * 60_000;
export { DEFAULT_BUILD, DEFAULT_COMMAND } from "./toolchain.js";
const TEARDOWN_TIMEOUT_MS = 60_000;
/** Far above any real vitest JSON report; a larger file is refused rather than read into memory. */
export const MAX_VITEST_REPORT_BYTES = 16 * 1024 * 1024;

export type Side = "base" | "head";

/** The reports each side writes, as `<name>.report` in its out dir; the base runs twice so a flaky reproducer can be ruled out. */
export const SIDE_REPORTS: Readonly<Record<Side, readonly string[]>> = { base: ["base", "base-rerun"], head: ["head"] };

export const MAX_HEAD_RUNS = 5;

/** The report names a side writes: the base's pair, or `head`, `head-2`, ... for each of the head's runs. */
export function reportNames(side: Side, headRuns = 1): readonly string[] {
  if (side === "base") return SIDE_REPORTS.base;
  return Array.from({ length: headRuns }, (_, index) => (index === 0 ? "head" : `head-${index + 1}`));
}

const validHeadRuns = (runs: number) => Number.isInteger(runs) && runs >= 1 && runs <= MAX_HEAD_RUNS;

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
  /** How many times the head side runs vitest after one install and build, an integer from 1 to 5; default 1. The base side ignores it. */
  headRuns?: number;
}

export async function addTree(ctx: Context, name: string, sha: string): Promise<string> {
  const dir = path.join(ctx.tmp, name);
  const result = await call(ctx, ctx.repo, "git", [...GIT_SAFETY, "worktree", "add", "--detach", dir, sha]);
  if (result.status !== 0) throw new RunError(`creating the ${name} worktree failed (exit ${result.status ?? "signal"})`);
  ctx.trees.push(dir);
  return dir;
}

export async function overlay(ctx: Context, tree: string, head: string, plan: FixProofPlan): Promise<void> {
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

/** Installs and builds the tree with its lockfile's toolchain and returns the test command it resolved. */
export async function prepare(ctx: Context, tree: string, side: string, config: FixProofConfig): Promise<string> {
  const tools = toolchainOf(tree);
  if (tools.install !== null) await shell(ctx, tree, tools.install, `${side}: install`);
  await shell(ctx, tree, config.build ?? tools.build, `${side}: build`);
  return config.command ?? tools.command;
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

// The sandbox user owns the output dir, so the file there could be a symlink to a forged report, a FIFO that blocks,
// or large enough to exhaust memory.
function readReportFile(file: string, name: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_VITEST_REPORT_BYTES) throw new RunError(`${name}: vitest report over ${MAX_VITEST_REPORT_BYTES} bytes`);
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

async function sudo(ctx: Context, args: readonly string[]): Promise<void> {
  const result = await call(ctx, ctx.tmp, "sudo", ["-n", "--", ...args]);
  if (result.status !== 0) throw new RunError(`base: sandbox setup failed (sudo ${args[0]} exit ${result.status ?? "signal"})`);
}

/** Runs `sh -c <script> sh ...args` in tree, inside the sandbox when a sandbox user is given. */
export function runInTree(ctx: Context, tree: string, script: string, args: readonly string[], sandboxUser: string | undefined) {
  if (sandboxUser === undefined) return sh(ctx, tree, script, args);
  const command = sandboxCommand(sandboxUser, ctx.deadline - Date.now(), sandboxEnv(tree, process.env), script, args);
  return call(ctx, tree, command.file, command.args);
}

/** Runs the given test files once and returns vitest's JSON report with repo-relative file names. */
export async function testReport(
  ctx: Context,
  tree: string,
  tests: readonly string[],
  command: string,
  name: string,
  sandboxUser?: string,
): Promise<unknown> {
  // A fresh dir per run, handed to the sandbox only now, so an earlier run cannot plant this run's report.
  const dir = path.join(ctx.tmp, `${name}-out`);
  fs.mkdirSync(dir);
  if (sandboxUser !== undefined) await sudo(ctx, ["chown", `${sandboxUser}:`, dir]);
  const out = path.join(dir, `${name}.json`);
  const args = ["--reporter=json", "--outputFile", out, "--testTimeout", "30000", ...tests];
  const result = await runInTree(ctx, tree, command, args, sandboxUser);
  const json = readReportFile(out, name);
  if (json === null) throw new RunError(`${name}: vitest wrote no report (exit ${result.status ?? "signal"})`);
  return relativeNames(JSON.parse(json), tree);
}

async function runTests(ctx: Context, tree: string, plan: FixProofPlan, command: string, name: string, sandboxUser?: string): Promise<string> {
  return encodeReport(await testReport(ctx, tree, plan.tests, command, name, sandboxUser));
}

function runnerIds(): { uid: number; gid: number } {
  if (process.getuid === undefined || process.getgid === undefined) throw new RunError("base: sandbox setup failed (no uid on this platform)");
  return { uid: process.getuid(), gid: process.getgid() };
}

// Root or the runner's own login would run the head's tests with exactly the reach the sandbox exists to take away.
async function assertSeparateUid(ctx: Context, user: string, runnerUid: number): Promise<void> {
  const result = await call(ctx, ctx.tmp, "id", ["-u", "--", user]);
  const uid = result.status === 0 && /^\d+\n?$/.test(result.stdout) ? Number(result.stdout) : null;
  if (uid === null) throw new RunError(`base: sandbox setup failed (no uid for ${user})`);
  if (uid === 0 || uid === runnerUid) throw new RunError(`base: sandbox setup failed (${user} is uid ${uid}, root or the runner)`);
}

/**
 * Hands the tree's directories to the sandbox user for body, then everything under ctx.tmp back to the runner so cleanup
 * can remove it. Only directories: pnpm hardlinks node_modules files to its store, which the runner keeps using.
 */
export async function withSandbox<T>(ctx: Context, tree: string, user: string, body: () => Promise<T>): Promise<T> {
  assertSandboxUser(user);
  const runner = runnerIds();
  await assertSeparateUid(ctx, user, runner.uid);
  fs.chmodSync(ctx.tmp, 0o711);
  try {
    await sudo(ctx, ["find", tree, "-type", "d", "-exec", "chown", `${user}:`, "{}", "+"]);
    return await body();
  } finally {
    await ctx.exec("sudo", ["-n", "--", "chown", "-R", `${runner.uid}:${runner.gid}`, ctx.tmp], { cwd: ctx.tmp, timeoutMs: TEARDOWN_TIMEOUT_MS });
  }
}

async function runHeadTests(ctx: Context, tree: string, plan: FixProofPlan, command: string, runs: number): Promise<string[]> {
  const reports: string[] = [];
  for (const name of reportNames("head", runs)) reports.push(await runTests(ctx, tree, plan, command, name));
  return reports;
}

async function runSide(ctx: Context, shas: Shas, side: Side, headRuns: number, sandboxUser?: string): Promise<string[]> {
  const plan = await planDiff(ctx, shas);
  if (plan.tests.length === 0) return reportNames(side, headRuns).map(() => encodeError("no tests planned"));
  const tree = await addTree(ctx, side, shas[side]);
  // The base builds before any head file lands in its tree, so nothing the PR carries runs during its install or build.
  const command = await prepare(ctx, tree, side, plan.config);
  if (side === "head") return runHeadTests(ctx, tree, plan, command, headRuns);
  await overlay(ctx, tree, shas.head, plan);
  const test = (name: string) => runTests(ctx, tree, plan, command, name, sandboxUser);
  const both = async () => [await test("base"), await test("base-rerun")];
  return sandboxUser === undefined ? both() : withSandbox(ctx, tree, sandboxUser, both);
}

/** Builds and tests one side of the proof and writes its encoded reports to out; a failure writes error markers, never throws. */
export async function execSide(options: ExecSideOptions): Promise<void> {
  const headRuns = options.headRuns ?? 1;
  const names = reportNames(options.side, validHeadRuns(headRuns) ? headRuns : 1);
  const reports = await (validHeadRuns(headRuns)
    ? withContext(
        { ...options, budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS },
        (ctx, shas) => runSide(ctx, shas, options.side, headRuns, options.sandboxUser),
        (_shas, error) => names.map(() => encodeError(error)),
      )
    : Promise.resolve(names.map(() => encodeError(`headRuns must be an integer from 1 to ${MAX_HEAD_RUNS}, got ${headRuns}`)))
  ).catch((error: unknown) => names.map(() => encodeError(`${options.side}: cleanup failed: ${messageOf(error)}`)));
  try {
    fs.mkdirSync(options.out, { recursive: true });
    names.forEach((name, index) => fs.writeFileSync(path.join(options.out, `${name}.report`), reports[index] ?? ""));
  } catch {
    // The judge reads an absent report as a named error verdict, so swallowing a write failure still fails closed.
  }
}
