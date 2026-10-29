import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { depositItemId } from "@titan-design/owner-queue";
import {
  FRICTION_ASKER,
  frictionDailyReport,
  frictionDeposit,
  frictionDepositId,
  readWorkerReports,
  renderFrictionMarkdown,
  renderFrictionTop,
  type FrictionDailyReport,
} from "@titan-design/session-analytics";
import { z } from "zod";
import { withEventsDb } from "./insights/blocked-flow-sources.js";

/** The owner inbox, through titan-console's own CLI; tests inject a fake. */
export interface ConsoleInboxPort {
  /** Resolves false when the item is unknown or already answered, which leaves nothing to withdraw. */
  withdraw(id: string, reason: string): Promise<boolean>;
  file(deposit: ReturnType<typeof frictionDeposit>): Promise<string>;
}

interface FrictionDailyOptions {
  eventsDb: string;
  /** Holds `<date>.jsonl` and `<date>.md`. */
  archiveDir: string;
  now: Date;
  windowMs: number;
  dryRun: boolean;
  inbox: ConsoleInboxPort;
}

interface FrictionDailyResult {
  date: string;
  report: Omit<FrictionDailyReport, "rows">;
  top: string[];
  archived: string[];
  withdrawn: string[];
  filed: string | null;
}

/** A skipped day would otherwise leave its item open for good, so a week of earlier items is retired. */
const LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;
const utcDate = (at: Date) => at.toISOString().slice(0, 10);

/** One daily pass: read the window, archive the raw rows, retire earlier items, then file today's. A dry run reads only. */
export async function runFrictionDaily(options: FrictionDailyOptions): Promise<FrictionDailyResult> {
  const window = { since: new Date(options.now.getTime() - options.windowMs).toISOString(), until: options.now.toISOString() };
  const daily = withEventsDb(options.eventsDb, (db) => frictionDailyReport(readWorkerReports(db, window), window));
  const date = utcDate(options.now);
  const result = { date, report: summaryOf(daily), top: renderFrictionTop(daily), archived: [], withdrawn: [], filed: null };
  if (options.dryRun) return result;
  const archived = archive(options.archiveDir, date, daily);
  const deposit = frictionDeposit(daily, date, archived[0]!);
  const withdrawn = await withdrawEarlier(options.inbox, options.now, depositItemId(FRICTION_ASKER, deposit.depositId));
  return { ...result, archived, withdrawn, filed: await options.inbox.file(deposit) };
}

/** The rows go to the archive, not to stdout. */
function summaryOf({ window, reports, withFrictionField, withFallback, clusters }: FrictionDailyReport): FrictionDailyResult["report"] {
  return { window, reports, withFrictionField, withFallback, clusters };
}

function archive(dir: string, date: string, daily: FrictionDailyReport): string[] {
  mkdirSync(dir, { recursive: true });
  const jsonl = path.join(dir, `${date}.jsonl`);
  const md = path.join(dir, `${date}.md`);
  writeFileSync(jsonl, daily.rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  writeFileSync(md, renderFrictionMarkdown(daily, date));
  return [jsonl, md];
}

async function withdrawEarlier(inbox: ConsoleInboxPort, now: Date, newId: string): Promise<string[]> {
  const withdrawn: string[] = [];
  for (let back = 1; back <= LOOKBACK_DAYS; back += 1) {
    const id = depositItemId(FRICTION_ASKER, frictionDepositId(utcDate(new Date(now.getTime() - back * DAY_MS))));
    if (await inbox.withdraw(id, `superseded:${newId}`)) withdrawn.push(id);
  }
  return withdrawn;
}

export function renderFrictionResult(result: FrictionDailyResult): string {
  const { report } = result;
  const lines = [
    `friction-daily ${result.date}: ${report.reports} reports, ${report.withFrictionField} with Friction:, ${report.withFallback} fallback only`,
    ...(result.top.length > 0 ? result.top : ["no friction reported"]),
    ...result.archived.map((file) => `archived ${file}`),
    ...result.withdrawn.map((id) => `withdrew ${id}`),
    result.filed === null ? "dry run: nothing written or filed" : `filed ${result.filed}`,
  ];
  return `${lines.join("\n")}\n`;
}

const DURATION = /^(\d+)([hd])$/;

/** `--since` as `<n>h` or `<n>d`; null for anything else. */
export function parseWindowMs(spec: string): number | null {
  const match = DURATION.exec(spec);
  if (!match || Number(match[1]) === 0) return null;
  return Number(match[1]) * (match[2] === "d" ? DAY_MS : DAY_MS / 24);
}

/** `<active-work root>/titan-platform/artifacts/friction-daily`, beside the initiative's other experiment data. */
export const defaultFrictionArchive = (initiativesRoot: string) => path.join(initiativesRoot, "titan-platform", "artifacts", "friction-daily");

const execFileAsync = promisify(execFile);
/** titan-console's exit for an unknown item id. */
const EXIT_UNKNOWN_ITEM = 66;

const withdrawOutput = z.object({ outcome: z.string() });
const failedRun = z.object({ code: z.unknown(), stderr: z.unknown() });

/** An unknown id, or one the owner already answered, leaves nothing to withdraw. */
function nothingToWithdraw(error: unknown): boolean {
  const run = failedRun.safeParse(error);
  return run.success && (run.data.code === EXIT_UNKNOWN_ITEM || String(run.data.stderr).includes("already answered"));
}

/** titan-console on PATH; the deposit goes on stdin, so no shell ever sees its text. */
export const titanConsoleInbox: ConsoleInboxPort = {
  async withdraw(id, reason) {
    try {
      const { stdout } = await execFileAsync("titan-console", ["inbox", "withdraw", id, "--reason", reason, "--as", FRICTION_ASKER, "--actor", FRICTION_ASKER, "--json"]);
      return withdrawOutput.parse(JSON.parse(stdout)).outcome === "withdrawn";
    } catch (error) {
      if (nothingToWithdraw(error)) return false;
      throw error;
    }
  },
  async file(deposit) {
    const child = execFileAsync("titan-console", ["inbox", "file", "-"]);
    child.child.stdin!.end(JSON.stringify(deposit));
    return (await child).stdout.trim();
  },
};
