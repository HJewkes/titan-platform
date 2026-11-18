import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { rate } from "./report/format.js";
import { presentTracks, writeReport, type Report } from "./report/report.js";

interface ReportFlags {
  runR?: string;
  runI?: string;
  runP?: string;
  out: string;
  partial?: boolean;
  targetR?: number;
  targetI?: number;
  targetP?: number;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("expected a positive integer");
  return parsed;
}

const defined = <T>(entries: [string, T | undefined][]): Record<string, T> => Object.fromEntries(entries.filter((entry): entry is [string, T] => entry[1] !== undefined));

/** One line per arm per table, primary rate only, so a run's headline reads without opening the files. */
function summaryLines(report: Report): string[] {
  const head = `report: ${report.partial ? "PARTIAL " : ""}complete blocks ${JSON.stringify(report.completeBlocks)}`;
  const rows = presentTracks(report.tracks).flatMap((track) =>
    track.tables.flatMap((view) => view.rows.map((row) => `${track.track} ${view.id} ${row.arm}${row.side ? " (shared)" : ""}: ${rate(row.primary)}`)),
  );
  return [head, ...rows];
}

function runReport(flags: ReportFlags): Report {
  const runs = defined([
    ["r", flags.runR],
    ["i", flags.runI],
    ["p", flags.runP],
  ]);
  if (Object.keys(runs).length === 0) throw new Error("give at least one of --run-r, --run-i, --run-p");
  const targets = defined([
    ["r", flags.targetR],
    ["i", flags.targetI],
    ["p", flags.targetP],
  ]);
  return writeReport({ runs: Object.fromEntries(Object.entries(runs).map(([track, dir]) => [track, resolve(dir)])), partial: flags.partial === true, targets }, resolve(flags.out));
}

function reportCommand(onResult: (code: number) => void): Command {
  return new Command("report")
    .description("Read finished run ledgers and write <out>/report.json and the <out>/REPORT.md skeleton; no model calls")
    .option("--run-r <dir>", "the R run dir")
    .option("--run-i <dir>", "the I run dir")
    .option("--run-p <dir>", "the P run dir (its judgments.jsonl holds the pairwise outcomes)")
    .requiredOption("--out <dir>", "where report.json and REPORT.md go")
    .option("--partial", "mark the report PARTIAL")
    .option("--target-r <n>", "R's target complete blocks; fewer marks the report PARTIAL", positiveInt)
    .option("--target-i <n>", "I's target complete blocks", positiveInt)
    .option("--target-p <n>", "P's target complete blocks", positiveInt)
    .exitOverride()
    .action((flags: ReportFlags) => {
      try {
        for (const line of summaryLines(runReport(flags))) console.log(line);
        onResult(0);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench report: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}

/** Adds `report` to the bench command. */
export function registerReport(program: Command, onResult: (code: number) => void): Command {
  return program.addCommand(reportCommand(onResult));
}
