import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { errorLine, messageOf, type Shas } from "./context.js";
import { spawnExec, type Exec } from "./exec.js";
import { DEFAULT_JUDGE_BUDGET_MS, judge, type JudgeReports } from "./judge.js";
import { DEFAULT_BUDGET_MS, execSide } from "./side.js";
import { resolveShas, snapshotRepo } from "./snapshot.js";

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

type Repos = Record<"base" | "head" | "judge", string>;

function readReport(dir: string, name: string): string | undefined {
  const file = path.join(dir, `${name}.report`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
}

// Every snapshot is fetched before any side runs, so no code from either commit has run when the judge's inputs are made.
async function snapshots(options: RunOptions, work: string, deadline: number): Promise<{ shas: Shas; repos: Repos }> {
  const exec = options.exec ?? spawnExec;
  const source = path.resolve(options.repo);
  const shas = await resolveShas(exec, source, options, deadline);
  const repos: Repos = { base: path.join(work, "base.git"), head: path.join(work, "head.git"), judge: path.join(work, "judge.git") };
  for (const dest of Object.values(repos)) await snapshotRepo(exec, source, shas, dest, deadline);
  return { shas, repos };
}

async function runSides(options: RunOptions, work: string): Promise<string> {
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const remaining = () => Math.max(1, deadline - Date.now());
  const { shas, repos } = await snapshots(options, work, deadline);
  const side = { exec: options.exec, ...shas };
  const baseOut = path.join(work, "out", "base");
  // The base side finishes and removes its tree before the head side builds, as it does in its own CI job.
  await execSide({ ...side, repo: repos.base, side: "base", out: baseOut, budgetMs: remaining() });
  // Read now: the head side runs PR code as this user, which could otherwise rewrite the base reports before the judge.
  const reports: JudgeReports = { base: readReport(baseOut, "base"), baseRerun: readReport(baseOut, "base-rerun") };
  const headOut = path.join(work, "out", "head");
  await execSide({ ...side, repo: repos.head, side: "head", out: headOut, budgetMs: remaining() });
  reports.head = readReport(headOut, "head");
  // The judge keeps its own budget so a side that ran out of time still gets its timeout reported.
  return judge({ ...side, repo: repos.judge, reports, budgetMs: DEFAULT_JUDGE_BUDGET_MS });
}

/**
 * Runs both exec sides and the judge in this process and returns one fix-proof/v1 line; the local mode of the three CI jobs.
 * Each side and the judge read their own bare snapshot of the two commits, so nothing either side writes reaches the
 * caller's repo or the judge's. Failures become a verdict error line, never a throw.
 */
export async function run(options: RunOptions): Promise<string> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-reports-"));
  try {
    return await runSides(options, work);
  } catch (error) {
    return errorLine({ base: options.base, head: options.head }, messageOf(error));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
