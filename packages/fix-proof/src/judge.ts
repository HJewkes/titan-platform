import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { loadsOnlyCarried } from "./carried-closure.js";
import { classifyReports, type Classification } from "./classify.js";
import { errorLine, planDiff, RunError, withContext, type Context, type Shas } from "./context.js";
import type { Exec } from "./exec.js";
import { compileGlobs } from "./glob.js";
import { classifyMutants, mutantsError, unmatchedKillsIn, withCoverage, type MutantsResult } from "./mutant-classify.js";
import { testOnlyReading, type FixProofPlan } from "./plan.js";
import { formatResultLine, toResult, type FixProofResult } from "./result-line.js";
import { readBlob, readSpecs, readSpecsAtHead, SpecError } from "./spec-read.js";
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
  /** The PR's base branch, as fix-proof-run.sh shows a ref; the line names it so a reader binds it to the base it judged. */
  baseRef?: string;
  budgetMs?: number;
  exec?: Exec;
}

class ReportError extends Error {}

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

export function classifyDecoded(plan: FixProofPlan, reports: JudgeReports): Classification {
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

async function testsNeedingNoSpec(ctx: Context, plan: FixProofPlan, head: string): Promise<Set<string>> {
  const isCarried = compileGlobs(plan.config.carry);
  const read = (path: string) => readBlob(ctx, head, path);
  const exempt = new Set<string>();
  for (const test of plan.tests) if (await loadsOnlyCarried(test, read, isCarried)) exempt.add(test);
  return exempt;
}

async function judgeMutants(ctx: Context, plan: FixProofPlan, shas: Shas, encoded: string | undefined): Promise<MutantsResult> {
  try {
    const specs = await readSpecs(ctx, plan, shas);
    const needsNoSpec = await testsNeedingNoSpec(ctx, plan, shas.head);
    return withCoverage(classifyMutants(specs, decodeMutantsReport(encoded)), specs, plan.tests, needsNoSpec);
  } catch (error) {
    if (!(error instanceof SpecError || error instanceof RunError)) throw error;
    return mutantsError(error.message);
  }
}

/**
 * A source diff runs no mutant, so its specs' kills are matched against the head report instead: a kill naming no test
 * there would otherwise land unread and prove nothing to the next test-only diff that runs the spec (TP-4070). A spec
 * that does not read is left to the mutants job, which fails on it.
 */
async function unmatchedAtHead(ctx: Context, plan: FixProofPlan, shas: Shas, encodedHead: string | undefined): Promise<MutantsResult | undefined> {
  const head = decodeReport(encodedHead);
  if (!head.ok) return undefined;
  try {
    const unmatched = unmatchedKillsIn(await readSpecsAtHead(ctx, plan, shas.head), head.report);
    return unmatched.length > 0 ? mutantsError(unmatched.join("; ")) : undefined;
  } catch (error) {
    if (!(error instanceof SpecError)) throw error;
    return undefined;
  }
}

// A broken spec fails the whole line, since a source diff's verdict is otherwise read without its mutants.
function failOnSpec(result: FixProofResult, mutants: MutantsResult): void {
  result.mutants = mutants;
  if (result.verdict === "error") return;
  result.verdict = "error";
  result.error = `mutation spec: ${mutants.error ?? ""}`;
}

async function verdict(ctx: Context, plan: FixProofPlan, shas: Shas, reports: JudgeReports, baseRef: string | undefined): Promise<string> {
  const classification = classifyDecoded(plan, reports);
  const result = toResult({ head: shas.head, mergeBase: shas.base, plan, classification });
  if (baseRef !== undefined) result.base = baseRef;
  if (plan.mutations.length === 0) return formatResultLine(result);
  // Mutants stand in for base-vs-head proof only on a diff of test material alone; with source in it they prove nothing,
  // and a deleted test, or one renamed out of the tests, has no file left at head for a spec to sit beside.
  if (testOnlyReading(plan).testOnly) result.mutants = await judgeMutants(ctx, plan, shas, reports.mutants);
  else {
    const broken = await unmatchedAtHead(ctx, plan, shas, reports.head);
    if (broken !== undefined) failOnSpec(result, broken);
  }
  return formatResultLine(result);
}

/**
 * Classifies the exec sides' encoded reports against a plan it derives from git itself and returns the one fix-proof/v1 line.
 * It runs no code from either commit: every command it spawns is git, so a PR head cannot reach the verdict it prints.
 */
export function judge(options: JudgeOptions): Promise<string> {
  return withContext(
    { ...options, budgetMs: options.budgetMs ?? DEFAULT_JUDGE_BUDGET_MS },
    async (ctx, shas) => verdict(ctx, await planDiff(ctx, shas), shas, options.reports, options.baseRef),
    errorLine,
  );
}
