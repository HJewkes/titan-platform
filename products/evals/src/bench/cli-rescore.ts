import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { readJobRows, type JobRow } from "./ledger.js";
import { loadReviewQueue, type ReviewCase } from "./review/cases.js";
import { writeBundle } from "./review/job.js";
import { cloneGitFor, collectRepoRoot } from "./review/repos.js";
import { scoreReview } from "./review/score.js";

interface RescoreFlags {
  track: "r";
  run: string;
  cases: string;
  repoRoot?: Record<string, string>;
}

const SCORE_SCHEMA = "titan.bench-score/v1";

/** Where the job's bundle sat, so absolute paths in the saved message strip exactly as they did at scoring time. */
const jobBundleDir = (runDir: string, row: JobRow): string => join(runDir, "jobs", `${row.caseHash.slice(0, 16)}-${row.arm.id}`, "bundle");

async function rescoreRow(runDir: string, row: JobRow, benchCase: ReviewCase, gitFor: ReturnType<typeof cloneGitFor>): Promise<string> {
  const message = readFileSync(join(runDir, "artifacts", `${row.sessionId}.md`), "utf8");
  const bundleDir = jobBundleDir(runDir, row);
  rmSync(bundleDir, { recursive: true, force: true });
  try {
    await writeBundle(benchCase, bundleDir, gitFor);
    const result = scoreReview(benchCase, message === "" ? undefined : message, bundleDir);
    const { id: caseId, hash: caseHash } = benchCase;
    return JSON.stringify({ schema: SCORE_SCHEMA, track: row.track, arm: row.arm.id, caseId, caseHash, attempt: row.attempt, outcome: row.outcome, result });
  } finally {
    rmSync(join(bundleDir, ".."), { recursive: true, force: true });
  }
}

/** Re-scores every job that saved a final message; the scores file is replaced in one rename, so a crash keeps the old one. */
export async function rescoreRun(flags: RescoreFlags): Promise<number> {
  const runDir = resolve(flags.run);
  const cases = new Map(loadReviewQueue(resolve(flags.cases)).map((benchCase) => [benchCase.hash, benchCase]));
  const gitFor = cloneGitFor(flags.repoRoot ?? {});
  const rows = readJobRows(join(runDir, "jobs.jsonl")).filter((row) => existsSync(join(runDir, "artifacts", `${row.sessionId}.md`)));
  const lines: string[] = [];
  for (const row of rows) {
    const benchCase = cases.get(row.caseHash);
    if (benchCase === undefined) throw new Error(`job ${row.sessionId} names case ${row.caseId}, which is not in ${flags.cases}`);
    lines.push(await rescoreRow(runDir, row, benchCase, gitFor));
  }
  const temp = join(runDir, "scores.jsonl.tmp");
  writeFileSync(temp, lines.map((line) => `${line}\n`).join(""));
  renameSync(temp, join(runDir, "scores.jsonl"));
  return lines.length;
}

export function rescoreCommand(onResult: (code: number) => void): Command {
  return new Command("rescore")
    .description("Re-run the review scorer over a run's saved final messages and rewrite its scores.jsonl; no model calls")
    .addOption(new Option("--track <track>", "the track to rescore (only r)").choices(["r"]).makeOptionMandatory())
    .requiredOption("--run <dir>", "the run dir holding jobs.jsonl and artifacts/")
    .requiredOption("--cases <dir>", "the run's prepared cases (holds queue.jsonl)")
    .option("--repo-root <name=path>", "a local clone to bundle commits from, per repo name; repeatable", collectRepoRoot)
    .exitOverride()
    .action(async (flags: RescoreFlags) => {
      try {
        console.error(JSON.stringify({ rescored: await rescoreRun(flags) }));
        onResult(0);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench rescore: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}
