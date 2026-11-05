import { writeDeposit } from "@titan-design/owner-queue/spool";
import { openDatabase } from "@titan-design/store-sqlite";
import type { Command } from "commander";
import type { Verbs } from "../cli-types.js";
import { configPath, loadConfig } from "../config.js";
import { ownerInboxDir } from "../deploy-watch-ports.js";
import { parseSinceOption } from "../digest/command.js";
import { readAllGates } from "../shepherd/owner-friction-read.js";
import { loadSeatBook } from "../shepherd/seats.js";
import { isoWeek } from "../shepherd/stats.js";
import { auditClock, previousWeek, runAudit, type AuditOpts } from "./audit-command.js";
import { badByClass } from "./audit-render.js";
import { demotionDeposit } from "./cards.js";
import { formatOwnerGatesReport, ownerGatesReport, type OwnerGatesReport } from "./report.js";

const FOURTEEN_DAYS_MINUTES = 14 * 1440;

interface ReportOpts {
  /** Minutes, parsed from `14d`; absent means 14 days. */
  since?: number;
  json?: boolean;
  deposit?: boolean;
  /** Per class, the bad outcomes an audit found; absent means no audit was consulted. */
  auditBad?: ReadonlyMap<string, readonly string[]>;
}

/** Reads the gates through a read-only connection, so a running serve is never disturbed. */
function readReport(verbs: Verbs, opts: ReportOpts, now: number): OwnerGatesReport {
  const seats = loadSeatBook(loadConfig(configPath(verbs.io.env)).shepherd ?? {});
  const db = openDatabase(verbs.dbPath(), { readonly: true });
  try {
    return ownerGatesReport(readAllGates(db), { now, seats, windowDays: (opts.since ?? FOURTEEN_DAYS_MINUTES) / 1440, auditBad: opts.auditBad });
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

/** The Monday timer's verb: last week's audit, then the report whose cards hold a demotion for any class that audit found bad. */
async function weeklyAction(verbs: Verbs, opts: Pick<AuditOpts, "judge">): Promise<void> {
  const now = auditClock(verbs);
  const items = await runAudit(verbs, { week: previousWeek(now), judge: opts.judge, keepExisting: true }, now);
  if (items) await reportAction(verbs, { deposit: true, auditBad: badByClass(items) }, now);
}

function registerAuditVerbs(ownerGates: Command, verbs: Verbs): void {
  ownerGates
    .command("audit")
    .description("a seeded sample of 5 owner-resolved gates from one ISO week, each with its 72 h outcome and a sonnet judge note; writes <active root>/titan-platform/sources/owner-gate-audit-<YYYY-Www>.md")
    .option("--week <YYYY-Www>", "the ISO week to audit (default: the previous week)")
    .option("--dry-run", "print the markdown and write nothing")
    .option("--force", "replace the week's file if it exists")
    .option("--no-judge", "skip the model call; each item reads judge unavailable: disabled")
    .action(async (opts: AuditOpts) => void (await runAudit(verbs, opts, auditClock(verbs))));
  ownerGates
    .command("weekly")
    .description("audit the previous ISO week (keeping a file already written), then run report --deposit with that audit's bad outcomes holding their classes")
    .option("--no-judge", "skip the model call in the audit")
    .action((opts: Pick<AuditOpts, "judge">) => weeklyAction(verbs, opts));
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
  registerAuditVerbs(ownerGates, verbs);
}
