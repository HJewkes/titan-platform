import { writeDeposit } from "@titan-design/owner-queue/spool";
import { openDatabase } from "@titan-design/store-sqlite";
import type { Command } from "commander";
import type { Verbs } from "../cli.js";
import { configPath, loadConfig } from "../config.js";
import { ownerInboxDir } from "../deploy-watch-ports.js";
import { parseSinceOption } from "../digest/command.js";
import { readAllGates } from "../shepherd/owner-friction-read.js";
import { loadSeatBook } from "../shepherd/seats.js";
import { isoWeek } from "../shepherd/stats.js";
import { demotionDeposit } from "./cards.js";
import { formatOwnerGatesReport, ownerGatesReport, type OwnerGatesReport } from "./report.js";

const FOURTEEN_DAYS_MINUTES = 14 * 1440;

interface ReportOpts {
  /** Minutes, parsed from `14d`; absent means 14 days. */
  since?: number;
  json?: boolean;
  deposit?: boolean;
}

/** Reads the gates through a read-only connection, so a running serve is never disturbed. */
function readReport(verbs: Verbs, opts: ReportOpts, now: number): OwnerGatesReport {
  const seats = loadSeatBook(loadConfig(configPath(verbs.io.env)).shepherd ?? {});
  const db = openDatabase(verbs.dbPath(), { readonly: true });
  try {
    return ownerGatesReport(readAllGates(db), { now, seats, windowDays: (opts.since ?? FOURTEEN_DAYS_MINUTES) / 1440 });
  } finally {
    db.close();
  }
}

/** One card per class proposed for demotion; a held class gets none. */
async function depositCards(verbs: Verbs, report: OwnerGatesReport, week: string): Promise<string[]> {
  const inbox = ownerInboxDir(verbs.io.env);
  const lines: string[] = [];
  for (const flag of report.flagged.filter((candidate) => candidate.held.length === 0)) {
    const { file, created } = await writeDeposit(inbox, demotionDeposit(flag, week));
    lines.push(`${created ? "deposited" : "already filed"} ${flag.class} ${file}`);
  }
  return lines;
}

async function reportAction(verbs: Verbs, opts: ReportOpts, now: number): Promise<void> {
  let report: OwnerGatesReport;
  try {
    report = readReport(verbs, opts, now);
  } catch (error) {
    return (verbs.io.stderr(`error: cannot read the gates or seat book: ${error instanceof Error ? error.message : String(error)}\n`), verbs.setExit(2));
  }
  const deposits = opts.deposit ? await depositCards(verbs, report, isoWeek(now)) : [];
  if (opts.json) return verbs.io.stdout(`${JSON.stringify({ ...report, ...(opts.deposit && { deposits }) }, null, 2)}\n`);
  verbs.io.stdout(`${formatOwnerGatesReport(report)}${deposits.map((line) => `${line}\n`).join("")}`);
}

/** `titan-factory owner-gates`: the weekly meter of what the owner rubber-stamps, and the cards that propose a demotion. */
export function registerOwnerGates(program: Command, verbs: Verbs): void {
  const ownerGates = program.command("owner-gates").description("the owner's approve rate per decision class and the standing grants");
  ownerGates
    .command("report")
    .description("per decision class over the window: owner-answered gates, approve rate, cancelled-unanswered and median wait; flags a class at 95% or more approve over 20 or more answered; lists standing grants with the gates resolved under each")
    .option("--since <window>", "the window back from now (default 14d)", parseSinceOption)
    .option("--json", "print the report as JSON")
    .option("--deposit", "file one two-way owner card per class proposed for demotion; a re-run in the same ISO week files none again")
    .action((opts: ReportOpts) => reportAction(verbs, opts, Date.now()));
}
