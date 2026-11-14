import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { defaultArms, parseArms, TRACKS, type Track } from "./arms.js";
import { createGuard, machineReaders } from "./guard.js";
import { prepareRunBin, spawnLauncher } from "./job.js";
import { meterJob } from "./meter.js";
import { promptPlugin, loadPromptCases } from "./prompt-track.js";
import { loadReviewQueue } from "./review/cases.js";
import { reviewPlugin } from "./review/job.js";
import { cloneGitFor, collectRepoRoot } from "./review/repos.js";
import { runBench, type BenchCase, type RunOptions } from "./runner.js";

interface RunFlags {
  track: Track;
  cases: string;
  arms?: string;
  pilot?: boolean;
  out: string;
  maxInflight: number;
  limitBlocks?: number;
  seed: string;
  configDir?: string;
  accountProfile: string;
  osSandbox?: boolean;
  repoRoot?: Record<string, string>;
}

const positiveInt = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("expected a positive integer");
  return parsed;
};

type SharedOptions = Omit<RunOptions<BenchCase>, "plugin" | "cases">;

/** Each track brings its own case loader and plugin; tracks without one yet run literal prompts. */
function runTrack(flags: RunFlags, shared: SharedOptions): ReturnType<typeof runBench> {
  if (flags.track === "r") {
    const plugin = reviewPlugin({ gitFor: cloneGitFor(flags.repoRoot ?? {}), runDir: shared.outDir });
    return runBench({ ...shared, plugin, cases: loadReviewQueue(flags.cases) });
  }
  return runBench({ ...shared, plugin: promptPlugin(flags.track), cases: loadPromptCases(flags.cases) });
}

async function runFlags(flags: RunFlags): Promise<boolean> {
  const configDir = flags.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (configDir === undefined || configDir === "") throw new Error("--config-dir or CLAUDE_CONFIG_DIR names the profile the jobs log in with");
  const outDir = resolve(flags.out);
  const arms = flags.arms === undefined ? defaultArms(flags.track, flags.pilot === true) : parseArms(JSON.parse(readFileSync(flags.arms, "utf8")));
  const summary = await runTrack(flags, {
    arms,
    outDir,
    configDir,
    operatorHome: homedir(),
    osSandbox: flags.osSandbox === true,
    jobPath: prepareRunBin(outDir, process.env.PATH ?? ""),
    seed: flags.seed,
    launcher: spawnLauncher,
    guard: createGuard({ readers: machineReaders(flags.accountProfile), jobsDir: outDir, log: (line) => console.error(line) }),
    meter: meterJob,
    maxInflight: flags.maxInflight,
    limitBlocks: flags.limitBlocks,
    log: (line) => console.error(line),
  });
  console.error(JSON.stringify(summary));
  return summary.stopped === undefined;
}

export function runCommand(onResult: (code: number) => void): Command {
  return new Command("run")
    .description("Run every (case, arm) job of a track as headless claude, block by block; resumes from <out>/jobs.jsonl")
    .addOption(new Option("--track <track>", "r (review), i (implement) or p (plan)").choices(TRACKS).makeOptionMandatory())
    .requiredOption("--cases <dir>", "the track's prepared cases")
    .option("--arms <arms.json>", "a JSON array of {id, model, effort} (default: the track's design arms)")
    .option("--pilot", "with the default arms, include the pilot-only ones")
    .requiredOption("--out <dir>", "the run dir: ledgers, settings, transcripts, results")
    .option("--max-inflight <n>", "jobs running at once", positiveInt, 6)
    .option("--limit-blocks <n>", "run only the first n blocks (cases)", positiveInt)
    .option("--seed <text>", "seeds each block's arm order", "bench-2026-11")
    .option("--config-dir <dir>", "the claude profile jobs log in with (default: $CLAUDE_CONFIG_DIR)")
    .option("--account-profile <label>", "the anthropic-account profile whose seven-day use stops the run", "agents")
    .option("--os-sandbox", "run each job's Bash under claude's bubblewrap sandbox; needs unprivileged user namespaces")
    .option("--repo-root <name=path>", "track r: a local clone to bundle commits from, per repo name; repeatable", collectRepoRoot)
    .exitOverride()
    .action(async (flags: RunFlags) => {
      try {
        onResult((await runFlags(flags)) ? 0 : 1);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench run: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}
