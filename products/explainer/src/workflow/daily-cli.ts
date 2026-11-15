import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { RunOutcome } from "./host.js";
import { budget, runRunCli, type RunCliDeps } from "./run-cli.js";

const DAILY_BUDGET_USD = 6;
const DAY_MS = 86_400_000;

interface DailyCliDeps extends RunCliDeps {
  now?: () => Date;
  run?: (argv: readonly string[], deps: RunCliDeps) => Promise<number>;
}

interface DailyFlags {
  day?: string;
  budgetUsd: number;
  repo: string[];
  transcripts: string[];
  dataDir?: string;
  theater?: string;
  initiative?: string;
}

const collect = (value: string, acc: string[] = []): string[] => [...acc, value];

function isDay(text: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new InvalidArgumentError(`--day takes YYYY-MM-DD, got "${text}"`);
  return text;
}

/** The UTC day before the clock's, so a timer at any time of day covers the day that has closed. */
const closedDay = (now: Date): string => new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);

function runArgv(flags: DailyFlags, day: string): string[] {
  return [
    "run", "--from", "gather", "--facts-from", "gatherDaily", "--type", "daily-overview", "--profile", "daily-overview",
    "--reflection", "deposit", "--budget-usd", String(flags.budgetUsd), "--day", day,
    ...flags.repo.flatMap((repo) => ["--repo", repo]),
    ...flags.transcripts.flatMap((dir) => ["--transcripts", dir]),
    ...(flags.dataDir ? ["--data-dir", flags.dataDir] : []),
    ...(flags.theater ? ["--theater", flags.theater] : []),
    ...(flags.initiative ? ["--initiative", flags.initiative] : []),
  ];
}

function parseFlags(argv: readonly string[], deps: RunCliDeps): DailyFlags {
  let flags: DailyFlags | undefined;
  const command = new Command("daily")
    .description("Run the closed UTC day's daily-overview digest from gather, on a $6 cap unless --budget-usd says otherwise")
    .option("--day <date>", "the UTC day to cover, YYYY-MM-DD (default: the day before the clock's UTC date)", isDay)
    .option("--budget-usd <usd>", "spend cap", budget, DAILY_BUDGET_USD)
    .option("--repo <owner/name>", "a repo whose PRs the gather reads (repeatable)", collect, [])
    .option("--transcripts <dir>", "a Claude Code transcript root (repeatable)", collect, [])
    .option("--data-dir <dir>", "run state and artifacts (default: the per-user data dir)")
    .option("--theater <dir>", "the folder export links the video into")
    .option("--initiative <slug>", "the active-work initiative the gather snapshots")
    .exitOverride()
    .configureOutput({ writeOut: deps.out ?? ((t) => process.stdout.write(t)), writeErr: deps.err ?? ((t) => process.stderr.write(t)) })
    .action((parsed: DailyFlags) => { flags = parsed; });
  command.parse([...argv], { from: "user" });
  return flags!;
}

/** `explainer daily [...]`: exit 0 on a completed run, 1 on a stopped or failed one, 2 on usage. */
export async function runDailyCli(argv: readonly string[], deps: DailyCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  let flags: DailyFlags;
  try {
    flags = parseFlags(argv.slice(1), deps);
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    throw error;
  }
  const day = flags.day ?? closedDay((deps.now ?? (() => new Date()))());
  const runDeps: RunCliDeps = { host: deps.host, gather: deps.gather, out: deps.out, err: deps.err, onOutcome: deps.onOutcome };
  const onOutcome = (outcome: RunOutcome): void => {
    runDeps.onOutcome?.(outcome);
    out(`daily run ${outcome.runId}: ${outcome.status}; $${outcome.report.totals.usd.toFixed(4)} for ${day}\n`);
  };
  return (deps.run ?? runRunCli)(runArgv(flags, day), { ...runDeps, onOutcome });
}
