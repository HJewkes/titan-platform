import { classifyReports, type Classification } from "./classify.js";
import { errorLine, planDiff, withContext, type Shas } from "./context.js";
import type { Exec } from "./exec.js";
import type { FixProofPlan } from "./plan.js";
import { formatResultLine, toResult } from "./result-line.js";
import { decodeReport, type DecodedReport } from "./transport.js";

/** Git calls only, so a short budget; the judge's CI job allows 8 minutes. */
export const DEFAULT_JUDGE_BUDGET_MS = 5 * 60_000;
// Decoded report paths are repo-relative; rooting them at "/" lets the classifier's path check read them as they are.
const REPORT_ROOT = "/";

export interface JudgeReports {
  /** Encoded reports from the exec jobs, as `encodeReport` or `encodeError` wrote them; absent means the job wrote none. */
  base?: string;
  baseRerun?: string;
  head?: string;
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

function verdict(plan: FixProofPlan, shas: Shas, reports: JudgeReports): string {
  const classification = classifyDecoded(plan, reports);
  return formatResultLine(toResult({ head: shas.head, mergeBase: shas.base, plan, classification }));
}

/**
 * Classifies the exec sides' encoded reports against a plan it derives from git itself and returns the one fix-proof/v1 line.
 * It runs no code from either commit: every command it spawns is git, so a PR head cannot reach the verdict it prints.
 */
export function judge(options: JudgeOptions): Promise<string> {
  return withContext(
    { ...options, budgetMs: options.budgetMs ?? DEFAULT_JUDGE_BUDGET_MS },
    async (ctx, shas) => verdict(await planDiff(ctx, shas), shas, options.reports),
    errorLine,
  );
}
