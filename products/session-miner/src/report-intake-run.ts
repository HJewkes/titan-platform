import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { readWorkerReports } from "@titan-design/session-analytics";
import type { Command } from "commander";
import type { MinerConfig } from "./config.js";
import { parseWindowMs } from "./friction-daily-run.js";
import { withEventsDb } from "./insights/blocked-flow-sources.js";
import { intakeRow, type IntakeRow } from "./report-intake.js";
import { agreement, goldFor, isPlainDone, type Agreement } from "./report-intake-eval.js";

interface IntakeResult {
  window: { since: string; until: string };
  reports: number;
  parsed: number;
  rows: IntakeRow[];
  /** Present with `--eval`: suggestions against what happened next, over plain DONE reports and over all. */
  eval?: { plainDone: Agreement; all: Agreement };
  written: string | null;
}

interface IntakeOptions {
  eventsDb: string;
  now: Date;
  windowMs: number;
  evaluate: boolean;
  /** Where the rows go as JSON lines; null writes nothing. */
  out: string | null;
}

export function runReportIntake(options: IntakeOptions): IntakeResult {
  const window = { since: new Date(options.now.getTime() - options.windowMs).toISOString(), until: options.now.toISOString() };
  const { rows, evaluated } = withEventsDb(options.eventsDb, (db) => {
    const rows = readWorkerReports(db, window).map(intakeRow);
    if (!options.evaluate) return { rows, evaluated: undefined };
    const gold = new Map(rows.map((row) => [row.eventId, goldFor(db, row)]));
    const over = (keep: (row: IntakeRow) => boolean) => agreement(rows.filter(keep).map((row) => gold.get(row.eventId)!));
    return { rows, evaluated: { plainDone: over(isPlainDone), all: over((row) => row.status !== "unknown") } };
  });
  const parsed = rows.filter((row) => row.status !== "unknown").length;
  const result: IntakeResult = { window, reports: rows.length, parsed, rows, written: null };
  if (evaluated !== undefined) result.eval = evaluated;
  if (options.out !== null) result.written = writeRows(options.out, rows);
  return result;
}

function writeRows(file: string, rows: readonly IntakeRow[]): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return file;
}

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`);

const agreementLine = (label: string, a: Agreement) =>
  `${label}: ${a.reports} reports, strict ${percent(a.strict, a.reports)}, attributed ${percent(a.attributed, a.reports)} ` +
  `(retired ${a.gold.retired}, resumed ${a.gold.resumed}, messaged ${a.gold.messaged}, left ${a.gold.left})`;

function renderIntakeResult(result: IntakeResult): string {
  const counts = new Map<string, number>();
  for (const row of result.rows) for (const key of [`status ${row.status}`, ...row.concerns.map((c) => `concern ${c.class}`)]) counts.set(key, (counts.get(key) ?? 0) + 1);
  const lines = [
    `shadow intake ${result.window.since} .. ${result.window.until}: ${result.reports} reports, parsed ${result.parsed} (${percent(result.parsed, result.reports)})`,
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `  ${key}: ${n}`),
    ...(result.eval ? [agreementLine("plain DONE closeout match", result.eval.plainDone), agreementLine("all parsed closeout match", result.eval.all)] : []),
    result.written === null ? "nothing written; acted on nothing" : `wrote ${result.written}; acted on nothing`,
  ];
  return `${lines.join("\n")}\n`;
}

interface IntakeFlags {
  since: string;
  shadow?: boolean;
  eval?: boolean;
  out?: string;
}

/** `report intake`; shadow is the only mode until the rule table's match is trusted, so the flag is required. */
export function attachReportIntake(program: Command, config: () => MinerConfig, io: { stdout: (t: string) => void; stderr: (t: string) => void }, onExit: (code: number) => void): void {
  const group = program.commands.find((c) => c.name() === "report") ?? program.command("report").description("report commands");
  group
    .command("intake")
    .description("Parse the window's worker reports into rows of status, PR, head, CI, concern classes and suggested actions; acts on nothing")
    .option("--since <window>", "how far back to read, as <n>h or <n>d", "24h")
    .option("--shadow", "required: write rows and act on nothing")
    .option("--eval", "join each row to what happened next in the event log and print the match rates")
    .option("--out <file>", "where the rows go as JSON lines (default <state>/report-intake/<date>.jsonl)")
    .action((opts: IntakeFlags) => {
      const windowMs = parseWindowMs(opts.since);
      if (windowMs === null || opts.shadow !== true) {
        io.stderr(windowMs === null ? "error: --since takes <n>h or <n>d\n" : "error: only --shadow is supported; intake acts on nothing yet\n");
        return onExit(EXIT.USAGE);
      }
      const resolved = config();
      const now = new Date();
      const out = opts.out ?? path.join(resolved.stateDir, "report-intake", `${now.toISOString().slice(0, 10)}.jsonl`);
      const result = runReportIntake({ eventsDb: resolved.eventsDb, now, windowMs, evaluate: opts.eval === true, out });
      io.stdout(program.opts().json === true ? `${JSON.stringify(result)}\n` : renderIntakeResult(result));
      onExit(EXIT.OK);
    });
}
