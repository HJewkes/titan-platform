import { readFileSync } from "node:fs";
import path from "node:path";
import { CommanderError, type Command } from "commander";
import { auditCandidates, runAudit, selectAuditSample } from "./eval-audit.js";
import { flagCase } from "./eval-cases.js";
import { formatReplay, replayCases } from "./eval-replay.js";
import { readCases } from "./eval-cases.js";
import { casesDir, configPath, rowsDir } from "./paths.js";
import type { ScoreRunner } from "./seams.js";
import { VERDICTS, type Verdict } from "./step-rows.js";
import { loadWatchlist } from "./watchlist.js";

type Write = (line: string) => void;

/** Exit code for a flag that cannot be recorded. */
export const EXIT_FLAG = 3;

const GOLD_TOTAL_VERDICTS: Verdict[] = ["over", "under", "miss"];
const WEEK_MS = 7 * 24 * 3600 * 1000;

interface FlagOptions {
  transcript: string;
  card?: string;
  verdict: Verdict;
  goldTotal?: number;
  note?: string;
}

function addFlag(program: Command, write: Write): void {
  program
    .command("flag <id>")
    .description("Record the owner's verdict on a score as an eval case (input path and sha256, never transcript text)")
    .requiredOption("--transcript <file>", "transcript markdown the card was scored from")
    .requiredOption("--verdict <verdict>", `one of ${VERDICTS.join(", ")}`)
    .option("--card <file>", "score card (default: <id>.score.json beside the transcript)")
    .option("--gold-total <n>", "the total the card should have had; required for over, under and miss", Number)
    .option("--note <text>", "free text for the case")
    .action((id: string, o: FlagOptions) => {
      const fail = (message: string): never => {
        throw new CommanderError(EXIT_FLAG, "flag.invalid", message);
      };
      if (!VERDICTS.includes(o.verdict)) fail(`verdict must be one of ${VERDICTS.join(", ")}`);
      if (GOLD_TOTAL_VERDICTS.includes(o.verdict) && o.goldTotal === undefined) fail(`${o.verdict} needs --gold-total`);
      if (o.goldTotal !== undefined && !(Number.isInteger(o.goldTotal) && o.goldTotal >= 0 && o.goldTotal <= 15)) fail("--gold-total must be an integer 0 to 15");
      const transcriptPath = path.resolve(o.transcript);
      const cardPath = o.card ? path.resolve(o.card) : path.join(path.dirname(transcriptPath), `${id}.score.json`);
      write(`flagged ${id}: ${flagCase(casesDir(), { id, transcriptPath, cardPath, verdict: o.verdict, goldTotal: o.goldTotal, note: o.note })}`);
    });
}

interface ReplayOptions {
  model: string;
  rubric: string;
  maxCases: number;
  maxCost: number;
}

function addReplay(evalCmd: Command, write: Write, runner: ScoreRunner): void {
  evalCmd
    .command("replay")
    .description("Re-run every score case on a model; print threshold-side agreement, mean absolute difference and cost")
    .requiredOption("--model <model>", "model to replay on")
    .requiredOption("--rubric <file>", "RUBRIC.md, as for score")
    .option("--max-cases <n>", "stop after this many replayed cases", Number, Infinity)
    .option("--max-cost <usd>", "stop before a case once spend reaches this", Number, 2)
    .action(async (o: ReplayOptions) => {
      const config = loadWatchlist(configPath());
      const summary = await replayCases(readCases(casesDir()), {
        runner,
        rubric: readFileSync(o.rubric, "utf8"),
        model: o.model,
        thresholdTotal: config.scoring.threshold_total,
        maxCases: o.maxCases,
        maxCostUsd: o.maxCost,
      });
      for (const line of formatReplay(summary)) write(line);
    });
}

interface AuditOptions {
  model: string;
  rubric: string;
  since: string;
  seed?: string;
}

function addAudit(evalCmd: Command, write: Write, runner: ScoreRunner): void {
  evalCmd
    .command("audit")
    .description("Weekly: re-score a sample of recent cards on a stronger model and file a case for each disagreement")
    .requiredOption("--model <model>", "auditing model, e.g. claude-opus-5-5")
    .requiredOption("--rubric <file>", "RUBRIC.md, as for score")
    .option("--since <date>", "only cards scored on or after this ISO date (default: 7 days ago)", new Date(Date.now() - WEEK_MS).toISOString())
    .option("--seed <text>", "sampling seed (default: today's date)")
    .action(async (o: AuditOptions) => {
      const config = loadWatchlist(configPath());
      const sample = selectAuditSample(auditCandidates(rowsDir(), new Date(o.since), casesDir()), o.seed ?? new Date().toISOString().slice(0, 10));
      const report = await runAudit(sample, {
        runner,
        rubric: readFileSync(o.rubric, "utf8"),
        model: o.model,
        maxBudgetUsd: 0.25,
        thresholdTotal: config.scoring.threshold_total,
        casesDir: casesDir(),
      });
      write(`audit ${o.model}: ${report.sampled} sampled, ${report.filed.length} disagree, ${report.stale} stale, ${report.failed} failed, $${report.costUsd.toFixed(4)}`);
      for (const file of report.filed) write(`  audit-disagree: ${file}`);
    });
}

export function addEvalCommands(program: Command, write: Write, runner: ScoreRunner): void {
  addFlag(program, write);
  const evalCmd = program.command("eval").description("Eval-loop commands");
  addReplay(evalCmd, write, runner);
  addAudit(evalCmd, write, runner);
}
