import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorLine, messageOf } from "./context.js";
import type { Exec } from "./exec.js";
import { DEFAULT_JUDGE_BUDGET_MS, judge } from "./judge.js";
import { DEFAULT_BUDGET_MS, execSide } from "./side.js";

export { errorLine } from "./context.js";
export { DEFAULT_BUDGET_MS, DEFAULT_BUILD, DEFAULT_COMMAND } from "./side.js";

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

function readReport(dir: string, name: string): string | undefined {
  const file = path.join(dir, `${name}.report`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
}

async function runSides(options: RunOptions, out: string): Promise<string> {
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const remaining = () => Math.max(1, deadline - Date.now());
  // The base side finishes and removes its tree before the head side builds, as it does in its own CI job.
  await execSide({ ...options, side: "base", out, budgetMs: remaining() });
  await execSide({ ...options, side: "head", out, budgetMs: remaining() });
  const reports = { base: readReport(out, "base"), baseRerun: readReport(out, "base-rerun"), head: readReport(out, "head") };
  // The judge keeps its own budget so a side that ran out of time still gets its timeout reported.
  return judge({ ...options, reports, budgetMs: DEFAULT_JUDGE_BUDGET_MS });
}

/**
 * Runs both exec sides and the judge in this process and returns one fix-proof/v1 line; the local mode of the three CI jobs.
 * Failures become a verdict error line, never a throw.
 */
export async function run(options: RunOptions): Promise<string> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-reports-"));
  try {
    return await runSides(options, out);
  } catch (error) {
    return errorLine({ base: options.base, head: options.head }, messageOf(error));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
