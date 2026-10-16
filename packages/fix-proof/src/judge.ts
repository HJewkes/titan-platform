import { classifyReports, type Classification } from "./classify.js";
import { errorLine, git, planDiff, RunError, withContext, type Context, type Shas } from "./context.js";
import type { Exec } from "./exec.js";
import { compileGlobs } from "./glob.js";
import { classifyMutants, mutantsError, testFileOfSpec, type MutantsResult, type SpecUnderTest } from "./mutant-classify.js";
import { checkMutation, parseMutationSpec, type MutationSpec } from "./mutation.js";
import { testOnlyOf, type FixProofPlan } from "./plan.js";
import { formatResultLine, toResult } from "./result-line.js";
import { decodeMutantsReport, decodeReport, type DecodedReport } from "./transport.js";

/** Git calls only, so a short budget; the judge's CI job allows 8 minutes. */
export const DEFAULT_JUDGE_BUDGET_MS = 5 * 60_000;
// Decoded report paths are repo-relative; rooting them at "/" lets the classifier's path check read them as they are.
const REPORT_ROOT = "/";

export interface JudgeReports {
  /** Encoded reports from the exec jobs, as `encodeReport` or `encodeError` wrote them; absent means the job wrote none. */
  base?: string;
  baseRerun?: string;
  head?: string;
  /** The mutants side's combined report, as `encodeMutantsReport`, `encodeMutantsSkipped` or `encodeError` wrote it. */
  mutants?: string;
}

export interface JudgeOptions {
  /** The git checkout holding both commits; the judge reads it with git and never builds or runs it. */
  repo: string;
  base: string;
  head: string;
  reports: JudgeReports;
  budgetMs?: number;
  exec?: Exec;
}

class ReportError extends Error {}
class SpecError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rooted(decoded: DecodedReport, name: string): unknown {
  if (!decoded.ok) throw new ReportError(decoded.reported ? decoded.error : `${name}: ${decoded.error}`);
  const testResults = decoded.report.testResults.map((file) =>
    isRecord(file) && typeof file.name === "string" ? { ...file, name: REPORT_ROOT + file.name } : file,
  );
  return { testResults };
}

function classifyAgainst(plan: FixProofPlan, base: unknown, head: unknown): Classification {
  return classifyReports({ selected: plan.tests, base: { root: REPORT_ROOT, report: base }, head: { root: REPORT_ROOT, report: head } });
}

function classifyDecoded(plan: FixProofPlan, reports: JudgeReports): Classification {
  if (plan.tests.length === 0) return { verdict: "no-tests", tests: [], files: [] };
  try {
    const base = rooted(decodeReport(reports.base), "base");
    const head = rooted(decodeReport(reports.head), "head");
    const first = classifyAgainst(plan, base, head);
    // A vacuous verdict may be a reproducer that flaked green once; the second base run rules that out.
    if (first.verdict !== "vacuous") return first;
    return classifyAgainst(plan, rooted(decodeReport(reports.baseRerun), "base-rerun"), head);
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    return { verdict: "error", tests: [], files: [], error: error.message };
  }
}

// A blob that is not a regular file (a symlink or a gitlink) reads as missing, so a mutation never writes through one.
async function readBlob(ctx: Context, sha: string, file: string): Promise<string | null> {
  const listed = await git(ctx, ["ls-tree", sha, "--", file], `listing ${file}`);
  if (!/^100(?:644|755) blob /.test(listed)) return null;
  return git(ctx, ["show", `${sha}:${file}`], `reading ${file}`);
}

async function headFilesBeside(ctx: Context, head: string, spec: string): Promise<string[]> {
  const dir = spec.includes("/") ? spec.slice(0, spec.lastIndexOf("/")) : "";
  const pathspec = dir === "" ? [] : ["--", dir];
  return (await git(ctx, ["ls-tree", "-r", "--name-only", head, ...pathspec], "listing the spec's directory")).split("\n").filter(Boolean);
}

async function readSpecAtHead(ctx: Context, head: string, path: string): Promise<MutationSpec> {
  const text = await readBlob(ctx, head, path);
  if (text === null) throw new SpecError(`${path}: not a regular file at head`);
  const parsed = parseMutationSpec(text);
  if (!parsed.ok) throw new SpecError(`${path}: ${parsed.error}`);
  return parsed.spec;
}

async function readSpec(ctx: Context, plan: FixProofPlan, shas: Shas, path: string): Promise<SpecUnderTest> {
  const spec = await readSpecAtHead(ctx, shas.head, path);
  const testFile = testFileOfSpec(path, await headFilesBeside(ctx, shas.head, path), compileGlobs(plan.config.tests));
  if (testFile === null) throw new SpecError(`${path}: no single test file sits beside it`);
  for (const mutation of spec.mutations) {
    const checked = checkMutation(mutation, await readBlob(ctx, shas.base, mutation.file), plan.config);
    if (!checked.ok) throw new SpecError(`${path}: ${checked.error}`);
  }
  return { path, testFile, mutations: spec.mutations };
}

async function judgeMutants(ctx: Context, plan: FixProofPlan, shas: Shas, encoded: string | undefined): Promise<MutantsResult> {
  try {
    const specs: SpecUnderTest[] = [];
    for (const path of plan.mutations) specs.push(await readSpec(ctx, plan, shas, path));
    return classifyMutants(specs, decodeMutantsReport(encoded));
  } catch (error) {
    if (!(error instanceof SpecError || error instanceof RunError)) throw error;
    return mutantsError(error.message);
  }
}

async function verdict(ctx: Context, plan: FixProofPlan, shas: Shas, reports: JudgeReports): Promise<string> {
  const classification = classifyDecoded(plan, reports);
  const result = toResult({ head: shas.head, mergeBase: shas.base, plan, classification });
  // Mutants stand in for base-vs-head proof only on a diff of test material alone; with source in it they prove nothing.
  if (plan.mutations.length > 0 && testOnlyOf(plan)) result.mutants = await judgeMutants(ctx, plan, shas, reports.mutants);
  return formatResultLine(result);
}

/**
 * Classifies the exec sides' encoded reports against a plan it derives from git itself and returns the one fix-proof/v1 line.
 * It runs no code from either commit: every command it spawns is git, so a PR head cannot reach the verdict it prints.
 */
export function judge(options: JudgeOptions): Promise<string> {
  return withContext(
    { ...options, budgetMs: options.budgetMs ?? DEFAULT_JUDGE_BUDGET_MS },
    async (ctx, shas) => verdict(ctx, await planDiff(ctx, shas), shas, options.reports),
    errorLine,
  );
}
