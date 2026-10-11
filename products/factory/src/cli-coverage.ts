import { dirname, join } from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import type { CliIo } from "./cli.js";
import { configPath, loadConfig, type FactoryConfig } from "./config.js";
import { EXIT } from "./exit-codes.js";
import { readCoverage } from "./shepherd/coverage-read.js";
import type { CoverageReport } from "./shepherd/coverage.js";
import { loadSeatBook } from "./shepherd/seats.js";

/** The seats TP-1569's done-when measures: the four that merge through Shepherd under charter 8. */
const DEFAULT_SEATS = ["titan-coord", "design-coord", "voltras-coord", "platform-coord"];
const HOUR_MS = 3_600_000;

interface CoverageOpts {
  seat?: string[];
  end?: string;
  hours: number;
  logs?: string;
  min?: number;
  json?: boolean;
}

function parseHours(value: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) throw new InvalidArgumentError("expected a positive number of hours");
  return hours;
}

function parseShare(value: string): number {
  const share = Number(value);
  if (value.trim() === "" || !Number.isFinite(share) || share < 0 || share > 1) throw new InvalidArgumentError("expected a share from 0 to 1, e.g. 0.8");
  return share;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** `digest.logsDir`, else `logs` beside the seat book, as the digest reads the same dispatch logs. */
function logsDirOf(config: FactoryConfig, flag: string | undefined): string {
  const dir = flag ?? config.digest?.logsDir ?? (config.shepherd?.seatsDir ? join(dirname(config.shepherd.seatsDir), "logs") : undefined);
  if (dir === undefined) throw new Error("no dispatch logs directory: pass --logs, or set digest.logsDir or shepherd.seatsDir in the config");
  return dir;
}

/** The seat book serve loads; a seat missing from it keeps no remotes, so its bare PR numbers stay unresolved. */
function remotesOf(config: FactoryConfig, seats: readonly string[]): Record<string, string[]> {
  const book = loadSeatBook(config.shepherd ?? {});
  return Object.fromEntries(seats.map((name) => [name, book.seats.find((seat) => seat.name === name)?.remotes ?? []]));
}

const shareText = (share: number | undefined): string => (share === undefined ? "n/a" : `${Math.round(share * 100)}%`);

function formatCoverage(report: CoverageReport): string {
  const counts = (label: string, c: CoverageReport["total"]): string => `${label}  merged ${c.merged}  excluded ${c.excluded}  shepherd ${c.shepherd}  share ${shareText(c.share)}`;
  const misses = report.misses.map((m) => `  ${m.seat}  ${m.pr}  ${m.note}${m.holdReason === null ? "" : `  hold: ${m.holdReason}`}${m.unresolved ? "  (unresolved)" : ""}`);
  const holds = report.untypedHolds.map((h) => `  ${h.runId}  ${h.repo}#${h.pr ?? "-"}${h.servePath ? "  serve-path" : ""}${h.seatPath ? "  seat-path" : ""}  ${h.reason}`);
  return [
    `window ${new Date(report.window.start).toISOString()} to ${new Date(report.window.end).toISOString()}`,
    ...report.seats.map((s) => counts(s.seat, s)),
    counts("total", report.total),
    ...(misses.length > 0 ? ["", "misses:", ...misses] : []),
    ...(holds.length > 0 ? ["", "untyped holds:", ...holds] : []),
    ...(report.skipped > 0 ? ["", `skipped ${report.skipped} unreadable log lines`] : []),
    "",
  ].join("\n");
}

function windowOf(opts: CoverageOpts, now: number): { start: number; end: number } {
  const end = opts.end === undefined ? now : Date.parse(opts.end);
  if (Number.isNaN(end)) throw new Error(`expected an ISO time for --end, got ${JSON.stringify(opts.end)}`);
  return { start: end - opts.hours * HOUR_MS, end };
}

/** Everything but the store: a bad flag, config or seat book is a usage error before the ledger is opened. */
function sourcesOf(opts: CoverageOpts, env: NodeJS.ProcessEnv, now: number): Omit<Parameters<typeof readCoverage>[0], "dbPath"> {
  const config = loadConfig(configPath(env));
  return { window: windowOf(opts, now), logsDir: logsDirOf(config, opts.logs), remotes: remotesOf(config, opts.seat ?? DEFAULT_SEATS) };
}

/** No counted merge cannot show the bar is met, so an empty window fails `--min` too. */
const belowBar = (report: CoverageReport, min: number | undefined): boolean => min !== undefined && (report.total.share === undefined || report.total.share < min);

function coverageAction(opts: CoverageOpts, io: CliIo, dbPath: string, now: number): number {
  let sources: ReturnType<typeof sourcesOf>;
  try {
    sources = sourcesOf(opts, io.env, now);
  } catch (error) {
    return (io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`), EXIT.USAGE);
  }
  let report: CoverageReport;
  try {
    report = readCoverage({ ...sources, dbPath });
  } catch (error) {
    return (io.stderr(`error: cannot read the store at ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`), EXIT.USAGE);
  }
  io.stdout(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatCoverage(report));
  return belowBar(report, opts.min) ? EXIT.FAILURE : EXIT.OK;
}

/** `titan-factory shepherd coverage`: the seats' merged PRs against completed Shepherd runs, from a read-only ledger. */
export function registerShepherdCoverage(shepherd: Command, io: CliIo, dbPath: () => string, setExit: (code: number) => void, now: () => number = Date.now): void {
  shepherd
    .command("coverage")
    .description("per seat and in total: how many PRs the seats' dispatch logs record as merged in the window a completed Shepherd run merged, with the misses and the held runs whose reason is not a charter 8 hold reason")
    .option("--seat <name>", `a seat to count, repeatable (default: ${DEFAULT_SEATS.join(", ")})`, collect)
    .option("--end <iso>", "end of the window (default: now)")
    .option("--hours <n>", "length of the window in hours", parseHours, 24)
    .option("--logs <dir>", "directory holding <seat>/dispatch.jsonl (default: digest.logsDir, else logs beside shepherd.seatsDir)")
    .option("--min <share>", "exit 1 when the total share is below this, from 0 to 1", parseShare)
    .option("--json", "print the report as JSON")
    .action((opts: CoverageOpts) => setExit(coverageAction(opts, io, dbPath(), now())));
}
