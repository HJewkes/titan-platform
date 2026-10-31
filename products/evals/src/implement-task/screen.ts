import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyDecoded, execSide, spawnExec, type Classification, type Exec, type FixProofPlan } from "@titan-design/fix-proof";
import { localCloneGit } from "../review-pr/bundle.js";
import { planHiddenTests, type ImplementTaskSource } from "./write-case.js";

/** One head side is an install, a build and three runs, which fix-proof's 18-minute default does not cover. */
export const SCREEN_BUDGET_MS = 30 * 60_000;
const HEAD_REPORTS = ["head", "head-2", "head-3"] as const;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const REPO_NAME = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

type ScreenVerdict = "keep" | "no-hidden-tests" | `screen-error:${string}` | "flaky" | "fails-on-accepted" | "vacuous" | "not-collected";
export type HeadRuns = readonly [Classification, Classification, Classification];

interface ScreenOptions {
  /** Holds `.scratch`, the export's to remove. */
  outDir: string;
  /** The local clone of `owner/repo`; it is only read, and a screen's worktrees go in a scratch clone of it. */
  cloneFor(repo: string): string | undefined;
  exec?: Exec;
}

// With no files the run has no report to read: an error marker from execSide, or a report that did not decode.
const hasNoReport = (run: Classification): boolean => run.verdict === "error" && run.files.length === 0;

// Sorted multisets: vitest allows duplicate names and may shuffle. File states count, since a load error and a file of declined tests both list no tests.
function shapeOf(run: Classification): string {
  const tests = run.tests.map((test) => JSON.stringify([test.file, test.name, test.class])).sort();
  const files = run.files.map((file) => JSON.stringify([file.file, file.head])).sort();
  return JSON.stringify([tests, files]);
}

const headCannotRun = (run: Classification): boolean =>
  run.tests.some((test) => test.class === "fails-on-head") || run.files.some((file) => file.head === "load-error" || file.head === "hook-error");

const collectedNowhere = (run: Classification): boolean => run.files.some((file) => file.head === "not-collected") || run.files.every((file) => file.base === "not-collected");

/** One run's verdict, read once every run is known to agree; the order puts what the accepted merge did ahead of what base did. */
function stableVerdict(run: Classification): ScreenVerdict {
  if (headCannotRun(run)) return "fails-on-accepted";
  if (collectedNowhere(run)) return "not-collected";
  if (run.verdict === "error") return `screen-error:${run.error ?? "unknown error"}`;
  if (run.tests.some((test) => test.class === "not-run")) return "not-collected";
  return run.tests.some((test) => test.class === "reproduces" || test.class === "new-api") ? "keep" : "vacuous";
}

/**
 * Whether an accepted merge's hidden tests can grade an implementation: stable over three head runs, green on the
 * accepted code, and able to fail on the base. A test head skips and base did not pass is absent from `tests`, so it
 * neither blocks nor earns a keep, but appearing in only some runs reads as flaky.
 */
export function screenVerdict(runs: HeadRuns): ScreenVerdict {
  if (runs.some((run) => run.verdict === "no-tests")) return "no-hidden-tests";
  const missing = runs.find(hasNoReport);
  if (missing !== undefined) return `screen-error:${missing.error ?? "unknown error"}`;
  if (new Set(runs.map(shapeOf)).size > 1) return "flaky";
  return stableVerdict(runs[0]);
}

async function scratchClone(source: string, repo: string, outDir: string, exec: Exec): Promise<string> {
  if (!REPO_NAME.test(repo)) throw new Error(`repo is not owner/name: ${JSON.stringify(repo)}`);
  const clone = join(outDir, ".scratch", repo);
  if (existsSync(clone)) return clone;
  mkdirSync(dirname(clone), { recursive: true });
  const result = await exec("git", ["clone", "--quiet", "--shared", "--no-checkout", "--", source, clone], { cwd: dirname(clone), timeoutMs: CLONE_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`scratch clone of ${repo} failed (exit ${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return clone;
}

function classifyRuns(plan: FixProofPlan, out: string): HeadRuns {
  const read = (name: string): string | undefined => {
    const file = join(out, `${name}.report`);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  };
  const shared = { base: read("base"), baseRerun: read("base-rerun") };
  const [first, second, third] = HEAD_REPORTS;
  const run = (name: string): Classification => classifyDecoded(plan, { ...shared, head: read(name) });
  return [run(first), run(second), run(third)];
}

async function screen(source: ImplementTaskSource, options: ScreenOptions, exec: Exec): Promise<ScreenVerdict> {
  const local = options.cloneFor(source.repo);
  if (local === undefined) throw new Error(`no local clone for ${source.repo}`);
  const plan = await planHiddenTests(localCloneGit(local), source.baseSha, source.mergeSha);
  const repo = await scratchClone(local, source.repo, options.outDir, exec);
  const out = `${repo}.reports/${source.pr}`;
  const side = { repo, base: source.baseSha, head: source.mergeSha, out, budgetMs: SCREEN_BUDGET_MS, exec };
  // No sandboxUser: these are accepted merges, so the base side runs nothing the head side would not.
  await execSide({ ...side, side: "base" });
  await execSide({ ...side, side: "head", headRuns: HEAD_REPORTS.length });
  return screenVerdict(classifyRuns(plan, out));
}

/** Builds and tests one accepted merge in a scratch clone under `<out>/.scratch`; any failure drops the case, so one bad commit never stops an export. */
export async function screenCase(source: ImplementTaskSource, options: ScreenOptions): Promise<ScreenVerdict> {
  try {
    return await screen(source, options, options.exec ?? spawnExec);
  } catch (error) {
    return `screen-error:${error instanceof Error ? error.message : String(error)}`;
  }
}
