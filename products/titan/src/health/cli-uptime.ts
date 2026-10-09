import { InvalidArgumentError, type Command } from "commander";
import { openHealthStore, readSamples, uptime, type HealthSample, type UptimeGap, type UptimeReport } from "@titan-design/health";

type Db = ReturnType<typeof openHealthStore>;

export interface ReportIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

export interface WindowOptions {
  window: number;
  end?: Date;
  db?: string;
  json?: boolean;
}

/** Exit 2: there is no readable store, so there is no record to report on. */
const EXIT_STORE = 2;
const EXIT_BELOW_MIN = 1;
const TEXT_GAPS = 10;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseWindow(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value);
  const ms = match ? Number(match[1]) * (UNIT_MS[match[2] ?? ""] ?? 0) : 0;
  if (ms <= 0) throw new InvalidArgumentError("expected a positive number of m, h or d, such as 24h");
  return ms;
}

function parseEnd(value: string): Date {
  const end = new Date(value);
  if (!Number.isFinite(end.getTime())) throw new InvalidArgumentError("expected an ISO timestamp");
  return end;
}

function parseShare(value: string): number {
  const share = Number(value);
  if (!(share >= 0 && share <= 1)) throw new InvalidArgumentError("expected a share between 0 and 1, such as 0.99");
  return share;
}

/** The `--window`, `--end`, `--db` and `--json` options every report command shares. */
export function windowOptions(command: Command, defaultWindow: string): Command {
  return command
    .option("--window <span>", "window ending at --end: <n>m, <n>h or <n>d", parseWindow, parseWindow(defaultWindow))
    .option("--end <iso>", "end of the window (default: now)", parseEnd)
    .option("--db <path>", "health store (default: $XDG_STATE_HOME/titan/health.sqlite3)")
    .option("--json", "print the report as JSON");
}

export function windowOf(opts: WindowOptions): { from: Date; to: Date } {
  const to = opts.end ?? new Date();
  return { from: new Date(to.getTime() - opts.window), to };
}

/** Runs `report` against the store opened read-only; a store that cannot be opened exits 2 with its path. */
export function withReadOnlyStore(dbPath: string, io: ReportIo, report: (db: Db) => number): number {
  let db: Db;
  try {
    db = openHealthStore(dbPath, { readonly: true });
  } catch (error) {
    io.stderr(`titan: could not open the health store ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_STORE;
  }
  try {
    return report(db);
  } finally {
    db.close();
  }
}

export interface CounterDelta {
  first: number | null;
  last: number | null;
  /** Null when there is no reading or the counter dropped somewhere in the window. */
  delta: number | null;
  /** serve's state file was reset, so `last - first` would undercount. */
  counterReset: boolean;
}

/** Delta of one of serve's own counters across the window; restarts are read, never inferred from gaps. */
export function counterDelta(samples: readonly HealthSample[], field: string): CounterDelta {
  const readings = samples.map((s) => s.observed?.[field]).filter((v): v is number => typeof v === "number");
  const first = readings[0] ?? null;
  const last = readings.at(-1) ?? null;
  const counterReset = readings.some((value, i) => i > 0 && value < (readings[i - 1] ?? value));
  const delta = first === null || last === null || counterReset ? null : last - first;
  return { first, last, delta, counterReset };
}

export interface UptimeCliReport extends UptimeReport {
  target: string;
  from: string;
  to: string;
  restarts: CounterDelta;
  uncleanStarts: CounterDelta;
}

function buildReport(db: Db, target: string, from: Date, to: Date): UptimeCliReport {
  const samples = readSamples(db, target, from, to);
  return {
    target,
    from: from.toISOString(),
    to: to.toISOString(),
    ...uptime(db, target, from, to),
    restarts: counterDelta(samples, "restartCount"),
    uncleanStarts: counterDelta(samples, "uncleanStartsTotal"),
  };
}

function percent(share: number | null): string {
  return share === null ? "n/a" : `${(share * 100).toFixed(2)}%`;
}

function counterText(counter: CounterDelta): string {
  if (counter.counterReset) return "unknown (counter reset)";
  return counter.delta === null ? "n/a" : String(counter.delta);
}

function gapMinutes(gap: UptimeGap): number {
  return (Date.parse(gap.to) - Date.parse(gap.from)) / 60_000;
}

function renderText(report: UptimeCliReport): string {
  const longest = [...report.gaps].sort((a, b) => gapMinutes(b) - gapMinutes(a)).slice(0, TEXT_GAPS);
  return [
    `${report.target} ${report.from} .. ${report.to}: ${report.slots} slots`,
    `up ${report.up}  down ${report.down}  unknown ${report.unknown}  missing ${report.missing}`,
    `up share of window ${percent(report.upShareOfWindow)}  of observed ${percent(report.upShareOfObserved)}`,
    `restarts ${counterText(report.restarts)}  unclean starts ${counterText(report.uncleanStarts)}`,
    `gaps ${report.gaps.length}${report.gaps.length > TEXT_GAPS ? ` (longest ${TEXT_GAPS})` : ""}`,
    ...longest.map((gap) => `  ${gap.from} .. ${gap.to} (${gapMinutes(gap)} min)`),
  ].join("\n");
}

interface UptimeOptions extends WindowOptions {
  min?: number;
}

function runUptime(target: string, opts: UptimeOptions, dbPath: string, io: ReportIo): number {
  return withReadOnlyStore(dbPath, io, (db) => {
    const { from, to } = windowOf(opts);
    const report = buildReport(db, target, from, to);
    io.stdout(`${opts.json ? JSON.stringify(report, null, 2) : renderText(report)}\n`);
    if (opts.min === undefined || (report.upShareOfWindow ?? 0) >= opts.min) return 0;
    io.stderr(`titan: ${target} up share of window ${percent(report.upShareOfWindow)} is below --min ${opts.min}\n`);
    return EXIT_BELOW_MIN;
  });
}

export function registerUptime(health: Command, io: ReportIo, defaultDbPath: () => string): void {
  windowOptions(health.command("uptime").argument("<target>", "target name, such as factory"), "24h")
    .description("Report a target's uptime, gaps and serve's own restart counts over a window")
    .option("--min <share>", "exit 1 when the up share of the window is below this", parseShare)
    .action((target: string, opts: UptimeOptions) => io.setExitCode(runUptime(target, opts, opts.db ?? defaultDbPath(), io)));
}
