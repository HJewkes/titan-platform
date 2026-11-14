import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Exec, ExecResult } from "@titan-design/fix-proof";
import { z } from "zod";
import { NOT_SOURCE, pkgOf } from "./corpus.js";

const STEP_SECS = 900;
const STEP_TIMEOUT_MS = (STEP_SECS + 60) * 1000;
const COPY_TIMEOUT_MS = 15 * 60_000;
/** Hooks and fsmonitor come from the arm's own `.git/config`, so the scorer turns both off. */
const SAFE_GIT = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

interface ScoredCase {
  id: string;
  hiddenTests: readonly string[];
  /** The accepted merge's non-test changed lines, the denominator of the diff ratio. */
  nonTestLines: number;
}

interface ScoreInput {
  benchCase: ScoredCase;
  /** The tree to score; only read, never written. */
  workspace: string;
  /** Owned by the scorer and absent until now: the fresh copy, a scratch HOME and the reports go here. */
  workDir: string;
  /** The seeded base commit every change is measured against. */
  rootSha: string;
  /** `<cases>/hidden/<id>`. */
  hiddenDir: string;
  /** Where the tree's diff against the root commit is saved. */
  patchPath: string;
  exec: Exec;
  /** PATH for scoring commands, which otherwise run in an emptied env. */
  path: string;
  /** The runner's corepack cache, read once to seed the scratch HOME. */
  corepackHome: string;
}

interface Step {
  name: string;
  status: number | null;
  seconds: number;
  tail?: string;
}

export interface ImplementResult {
  changed: boolean;
  touched: string[];
  hiddenPass: boolean;
  hiddenFailed: number | null;
  ownPass: boolean;
  typecheck: boolean;
  solved: boolean;
  armNonTestLines: number;
  acceptedNonTestLines: number;
  diffLogRatio: number | null;
  steps: Step[];
}

interface Scoring {
  input: ScoreInput;
  tree: string;
  /** Holds the scoring run's corepack and XDG dirs. */
  scratch: string;
  steps: Step[];
}

/**
 * Repo tests redact a user-home prefix (the Linux or macOS shape) out of messages and expect `~/<rest>`, so any other
 * HOME shape fails them on the accepted code itself. This one never exists: every dir a tool writes to is pointed
 * into the scratch dir through COREPACK_HOME and the XDG variables instead.
 */
const SCORING_HOME = posix.join(posix.sep, "home", "bench-scorer");
const XDG_DIRS = ["CACHE", "CONFIG", "DATA", "STATE"] as const;

const PackageManager = z.looseObject({ packageManager: z.string().optional() });

/**
 * `pnpm` here is corepack's shim, which downloads the repo's pinned pnpm when its cache lacks it, and every job and
 * scoring cache starts empty. Copying the one pinned version in keeps pnpm offline; a copy, so nothing a job does
 * reaches the operator's cache.
 */
export function seedCorepack(target: string, tree: string, corepackHome: string): void {
  const pinned = PackageManager.parse(JSON.parse(readFileSync(join(tree, "package.json"), "utf8"))).packageManager;
  const [name, version] = (pinned ?? "").split("+")[0]?.split("@") ?? [];
  if (name === undefined || version === undefined) return;
  const source = join(corepackHome, "v1", name, version);
  if (!existsSync(source)) throw new Error(`corepack has no ${name}@${version} under ${corepackHome}; run \`corepack install\` once`);
  cpSync(source, join(target, "v1", name, version), { recursive: true });
}

const tail = (result: ExecResult): string => (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-8).join("\n");

/** Every scoring command runs under `timeout` in an emptied env with no real HOME, so arm code reads no operator state. */
async function step(scoring: Scoring, name: string, command: readonly string[]): Promise<ExecResult> {
  const dirs = [`COREPACK_HOME=${join(scoring.scratch, "corepack")}`, ...XDG_DIRS.map((dir) => `XDG_${dir}_HOME=${join(scoring.scratch, dir.toLowerCase())}`)];
  const env = [`PATH=${scoring.input.path}`, `HOME=${SCORING_HOME}`, ...dirs, "LANG=C.UTF-8", "CI=true", "NODE_OPTIONS=--max-old-space-size=4096"];
  const started = Date.now();
  const result = await scoring.input.exec("env", ["-i", ...env, "timeout", "-k", "30", String(STEP_SECS), ...command], { cwd: scoring.tree, timeoutMs: STEP_TIMEOUT_MS });
  const seconds = Math.round((Date.now() - started) / 1000);
  scoring.steps.push({ name, status: result.status, seconds, ...(result.status !== 0 && { tail: tail(result) }) });
  return result;
}

async function freshCopy(input: ScoreInput, scratch: string): Promise<string> {
  const tree = join(input.workDir, "tree");
  for (const dir of XDG_DIRS) mkdirSync(join(scratch, dir.toLowerCase()), { recursive: true });
  const copied = await input.exec("cp", ["-a", "--reflink=auto", "--", input.workspace, tree], { cwd: input.workDir, timeoutMs: COPY_TIMEOUT_MS });
  if (copied.status !== 0) throw new Error(`scoring copy failed (exit ${copied.status ?? "signal"}): ${tail(copied)}`);
  seedCorepack(join(scratch, "corepack"), tree, input.corepackHome);
  return tree;
}

interface Diff {
  paths: string[];
  nonTestLines: number;
}

/** Staged first, so files the arm created but never committed count as its change. */
async function diffAgainstRoot(scoring: Scoring): Promise<Diff> {
  const { rootSha, patchPath } = scoring.input;
  const diff = [...SAFE_GIT, "diff", "--cached", "--no-renames", "--no-ext-diff"];
  const staged = await step(scoring, "stage", [...SAFE_GIT, "add", "-A"]);
  if (staged.status !== 0) throw new Error(`git add failed: ${tail(staged)}`);
  const patch = await step(scoring, "patch", [...diff, "--binary", rootSha]);
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, patch.stdout);
  const numstat = await step(scoring, "numstat", [...diff, "--numstat", rootSha]);
  if (patch.status !== 0 || numstat.status !== 0) throw new Error(`git diff against ${rootSha} failed: ${tail(numstat)}`);
  const rows = numstat.stdout.split("\n").flatMap((line) => {
    const [added, deleted, path] = line.split("\t");
    return path === undefined ? [] : [{ path, lines: (Number(added) || 0) + (Number(deleted) || 0) }];
  });
  const nonTestLines = rows.filter((row) => !NOT_SOURCE.test(row.path)).reduce((sum, row) => sum + row.lines, 0);
  return { paths: rows.map((row) => row.path), nonTestLines };
}

const VitestReport = z.looseObject({
  success: z.boolean(),
  numPassedTests: z.number(),
  numFailedTests: z.number(),
  testResults: z.array(z.looseObject({ name: z.string(), status: z.string() })),
});

/** The package build, its tests and its typecheck, over the tree as the arm left it, so its own tests count. */
async function ownChecks(scoring: Scoring, touched: readonly string[]): Promise<{ ownPass: boolean; typecheck: boolean }> {
  if (touched.length === 0) return { ownPass: true, typecheck: true };
  const dependents = touched.flatMap((pkg) => ["--filter", `...{./${pkg}}`]);
  const selected = touched.flatMap((pkg) => ["--filter", `{./${pkg}}`]);
  const build = await step(scoring, "build", ["pnpm", ...dependents, "--if-present", "build"]);
  if (build.status !== 0) return { ownPass: false, typecheck: false };
  const ownPass = await ownTests(scoring, touched);
  const typecheck = await step(scoring, "typecheck", ["pnpm", ...selected, "--if-present", "typecheck"]);
  return { ownPass, typecheck: typecheck.status === 0 };
}

/**
 * Whole-package suites carry timing-bound tests (`vi.waitFor`) that miss under this host's load even on the accepted
 * code, so failing files get one rerun on their own; a real regression fails both runs.
 */
async function ownTests(scoring: Scoring, touched: readonly string[]): Promise<boolean> {
  const reportPath = join(scoring.input.workDir, "own-report.json");
  const first = await step(scoring, "own-tests", ["pnpm", "vitest", "run", "--passWithNoTests", ...touched, "--reporter=json", "--outputFile", reportPath]);
  if (first.status === 0) return true;
  const parsed = existsSync(reportPath) ? VitestReport.safeParse(JSON.parse(readFileSync(reportPath, "utf8"))) : undefined;
  const failed = parsed?.success === true ? parsed.data.testResults.filter((file) => file.status !== "passed").map((file) => file.name) : [];
  if (failed.length === 0) return false;
  const rerun = await step(scoring, "own-tests-rerun", ["pnpm", "vitest", "run", ...failed]);
  return rerun.status === 0;
}

/** Later-fix roots (`fix-<pr>/`) are reported elsewhere; the accepted diff fails them by construction. */
function overlayHidden(hiddenDir: string, tree: string): void {
  if (!existsSync(hiddenDir)) throw new Error(`no hidden tests at ${hiddenDir}`);
  for (const entry of readdirSync(hiddenDir).filter((name) => !name.startsWith("fix-"))) {
    cpSync(join(hiddenDir, entry), join(tree, entry), { recursive: true, force: true });
  }
}

interface HiddenOutcome {
  hiddenPass: boolean;
  /** Failed hidden tests, or null when vitest wrote no report: a run that never started is not a failing test. */
  hiddenFailed: number | null;
}

/** Every hidden file must have run and passed: a file the arm's config excluded is a failure, not a pass. */
function readHidden(reportPath: string, status: number | null, hiddenTests: readonly string[]): HiddenOutcome {
  const parsed = existsSync(reportPath) ? VitestReport.safeParse(JSON.parse(readFileSync(reportPath, "utf8"))) : undefined;
  if (parsed?.success !== true) return { hiddenPass: false, hiddenFailed: null };
  const report = parsed.data;
  const passed = report.testResults.filter((file) => file.status === "passed").map((file) => file.name);
  const allRan = hiddenTests.every((test) => passed.some((name) => name.endsWith(`/${test}`)));
  const hiddenPass = status === 0 && report.success && report.numFailedTests === 0 && report.numPassedTests > 0 && allRan;
  return { hiddenPass, hiddenFailed: report.numFailedTests };
}

async function hiddenChecks(scoring: Scoring): Promise<HiddenOutcome> {
  const { hiddenDir, benchCase, workDir } = scoring.input;
  overlayHidden(hiddenDir, scoring.tree);
  const reportPath = join(workDir, "hidden-report.json");
  const run = await step(scoring, "hidden-tests", ["pnpm", "vitest", "run", ...benchCase.hiddenTests, "--reporter=json", "--outputFile", reportPath]);
  return readHidden(reportPath, run.status, benchCase.hiddenTests);
}

/**
 * Scores one finished tree on a fresh copy of it (design 1-I scoring): its diff against the root commit, then the
 * touched packages' build, tests and typecheck, then the withheld tests overlaid last. Hidden files enter the copy
 * only here, after the job has exited. A tree with no change still runs the hidden tests but is never solved.
 */
export async function scoreTree(input: ScoreInput): Promise<ImplementResult> {
  const scratch = join(input.workDir, "scratch");
  return scoreIn({ input, tree: await freshCopy(input, scratch), scratch, steps: [] });
}

async function scoreIn(scoring: Scoring): Promise<ImplementResult> {
  const { input } = scoring;
  const diff = await diffAgainstRoot(scoring);
  const changed = diff.paths.length > 0;
  const touched = [...new Set(diff.paths.flatMap((path) => pkgOf(path) ?? []))].sort();
  const own = changed ? await ownChecks(scoring, touched) : { ownPass: false, typecheck: false };
  const hidden = await hiddenChecks(scoring);
  const accepted = input.benchCase.nonTestLines;
  const ratio = diff.nonTestLines > 0 && accepted > 0 ? Math.log2(diff.nonTestLines / accepted) : null;
  const solved = changed && hidden.hiddenPass && own.ownPass && own.typecheck;
  const lines = { armNonTestLines: diff.nonTestLines, acceptedNonTestLines: accepted, diffLogRatio: ratio };
  return { changed, touched, ...hidden, ...own, solved, ...lines, steps: scoring.steps };
}

