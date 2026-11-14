import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { localCloneGit } from "../review-pr/bundle.js";
import { writeBaseTree } from "../implement-task/workspace.js";
import { landingsByTask, loadTasks, MAIN_LOG_ARGS, multiPool, parseMainLog, readRegistrations, singlePool, type PlanCase } from "./plan/cases.js";
import { samplePlanCases } from "./plan/sample.js";

interface PlanCasesFlags {
  tasks: string;
  repo: string;
  ghRepo: string;
  db?: string;
  out: string;
  multi: number;
  single: number;
  seed: string;
  since: string;
  createdSince: string;
  mergedSince: string;
}

const count = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError("expected a whole number");
  return parsed;
};

function tally(cases: readonly PlanCase[]): Record<string, number> {
  const kinds: Record<string, number> = { total: cases.length };
  for (const { kind } of cases) kinds[kind] = (kinds[kind] ?? 0) + 1;
  return kinds;
}

/** Cases go in as `cases/NN-<id>.json` in queue order; each base tree is archived once, outside every job. */
async function writeCases(flags: PlanCasesFlags, queue: readonly PlanCase[]): Promise<void> {
  const outDir = resolve(flags.out);
  rmSync(join(outDir, "cases"), { recursive: true, force: true });
  mkdirSync(join(outDir, "cases"), { recursive: true });
  const git = localCloneGit(resolve(flags.repo));
  for (const [index, planCase] of queue.entries()) {
    writeFileSync(join(outDir, "cases", `${String(index + 1).padStart(3, "0")}-${planCase.id}.json`), `${JSON.stringify(planCase, null, 2)}\n`);
    const merge = planCase.landed[0]?.mergeSha ?? "";
    if (!existsSync(join(outDir, "trees", planCase.id))) await writeBaseTree(git, { base: planCase.baseSha, merge }, outDir, planCase.id);
  }
}

async function buildPlanCases(flags: PlanCasesFlags): Promise<void> {
  const db = flags.db ?? process.env.TITAN_FACTORY_DB;
  if (db === undefined || db === "") throw new Error("--db or TITAN_FACTORY_DB names the factory database (opened read-only)");
  const tasks = loadTasks(flags.tasks);
  const log = (await localCloneGit(resolve(flags.repo)).git(MAIN_LOG_ARGS(flags.since))).toString("utf8");
  const landings = landingsByTask(parseMainLog(log), readRegistrations(db, flags.ghRepo), tasks);
  const options = { createdSince: flags.createdSince, mergedSince: flags.mergedSince };
  const pools = { multi: multiPool(tasks, landings, options), single: singlePool(tasks, landings, options) };
  const { queue, rejected } = samplePlanCases(pools, { multi: flags.multi, single: flags.single }, flags.seed);
  await writeCases(flags, queue);
  const manifest = {
    seed: flags.seed,
    pools: { multi: tally(pools.multi), single: tally(pools.single) },
    queue: queue.map(({ id, pool, kind, slicesLanded }) => ({ id, pool, kind, slicesLanded })),
    rejected: rejected.map(({ id, pool, kind }) => ({ id, pool, kind })),
  };
  writeFileSync(join(resolve(flags.out), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(JSON.stringify({ pools: manifest.pools, sampled: queue.length, rejected: rejected.length }));
}

/** Adds `plan-cases`: builds the P case set (multi and single pools), samples and queues it, and archives base trees. */
export function registerPlanCases(program: Command, onResult: (code: number) => void = (code) => void (process.exitCode = code)): Command {
  const command = new Command("plan-cases")
    .description("Build the P track's cases from task files, Shepherd registrations (read-only) and origin/main")
    .requiredOption("--tasks <dir>", "the active-work task files (*.yml)")
    .requiredOption("--repo <clone>", "a local clone whose origin/main holds the merges")
    .requiredOption("--gh-repo <owner/name>", "the GitHub repo whose Shepherd registrations count")
    .option("--db <path>", "factory.sqlite3, opened with mode=ro (default: $TITAN_FACTORY_DB)")
    .requiredOption("--out <dir>", "the case dir: cases/, trees/ and manifest.json")
    .option("--multi <n>", "P-multi cases to sample", count, 12)
    .option("--single <n>", "P-single cases to sample", count, 8)
    .option("--seed <text>", "seeds each stratum's draw order", "bench-2026-11")
    .option("--since <date>", "how far back origin/main is read", "2026-07-01")
    .option("--created-since <date>", "P-multi parents created on or after this date", "2026-10-01")
    .option("--merged-since <date>", "P-single PRs merged on or after this date", "2026-10-01")
    .exitOverride()
    .action(async (flags: PlanCasesFlags) => {
      try {
        await buildPlanCases(flags);
        onResult(0);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench plan-cases: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
  return program.addCommand(command);
}
