import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import type { Verbs } from "../../cli-types.js";
import { EXIT } from "../../exit-codes.js";
import { errorMessage } from "../../narrow.js";
import { firstPicks, scopedSpawns, type PickScope } from "./compare-picks.js";
import { agentChatHome, openEventsDb, readLedgerPicks, readOperatorSpawns, readShadowDays } from "./compare-read.js";
import { renderSection, upsertSection } from "./compare-report.js";
import { compareDay, laneKey, type CompareReport } from "./compare.js";
import { compareSettings, defaultRuleFilePath, loadRuleFile, type RuleFile } from "./rule-file.js";

/*
 * `dispatch shadow-compare` (TP-5755 S9): scores one day of shadow rows against the operator's real spawns. It writes
 * only `<shadow.dir>/../compare/<day>.json` and its own section of `<shadow.dir>/../COMPARE.md`.
 */

interface CompareOptions {
  day?: string;
  ruleFile?: string;
  eventsDb?: string;
  ledger?: string;
}

const DAY_MS = 86_400_000;

function readEvents(file: string, seat: string, from: number, to: number) {
  if (!existsSync(file)) throw new Error(`events database ${file} not found`);
  const db = openEventsDb(file);
  try {
    return readOperatorSpawns(db, seat, from, to);
  } finally {
    db.close();
  }
}

function buildReport(rules: RuleFile, dir: string, day: string, files: { eventsDb: string; ledger: string }): CompareReport {
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = from + DAY_MS;
  const { operator, prefixes } = compareSettings(rules);
  const scope: PickScope = { initiatives: new Set(rules.lanes.map((lane) => lane.initiative)), prefixes };
  const spawns = readEvents(files.eventsDb, operator, from - DAY_MS, to + DAY_MS);
  const nearby = scopedSpawns(spawns, scope).picks;
  const { counts } = scopedSpawns(spawns.filter((spawn) => spawn.ts >= from && spawn.ts < to), scope);
  const picks = firstPicks(nearby, readLedgerPicks(files.ledger, operator), from, to, scope);
  const shadow = readShadowDays(dir, day);
  const lanes = rules.lanes.map((lane) => laneKey(lane));
  const rows = { dayRows: shadow.day.rows, priorRows: shadow.prior.rows, badLines: shadow.day.badLines };
  return compareDay({ day, lanes, seat: operator, ...rows, picks, nearbyPicks: nearby, counts });
}

function writeOutputs(dir: string, report: CompareReport): string {
  const root = dirname(dir);
  const json = join(root, "compare", `${report.day}.json`);
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  const md = join(root, "COMPARE.md");
  writeFileSync(md, upsertSection(existsSync(md) ? readFileSync(md, "utf8") : "", report.day, renderSection(report)));
  return json;
}

function summary(report: CompareReport, json: string): string {
  const { counts } = report.operator;
  const rate = report.agreement.rate === null ? "n/a" : `${Math.round(report.agreement.rate * 100)}%`;
  const spawns = `operator spawns ${counts.found} (${counts.withTask} with meta.task, ${counts.withoutTask} without, ${counts.excludedByRole} excluded by role)`;
  const outcome = `picks ${report.operator.spawns}, agreement ${rate}, shadow-only ${report.shadowOnly.length}, operator-only ${report.operatorOnly.length}`;
  return `shadow-compare ${report.day}: ${report.wakes} wakes (${report.unreadableWakes} unreadable), ${spawns}, ${outcome} -> ${json}\n`;
}

async function runShadowCompare(opts: CompareOptions, verbs: Verbs): Promise<number> {
  if (opts.day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) {
    verbs.io.stderr("error: --day <YYYY-MM-DD> is required\n");
    return EXIT.USAGE;
  }
  try {
    const loaded = loadRuleFile(opts.ruleFile ?? defaultRuleFilePath(verbs.io.env));
    const dir = loaded?.rules.shadow.dir;
    if (loaded === undefined || dir === undefined) throw new Error("the rule file names no shadow.dir to compare");
    const home = agentChatHome(verbs.io.env);
    const report = buildReport(loaded.rules, dir, opts.day, { eventsDb: opts.eventsDb ?? join(home, "events.db"), ledger: opts.ledger ?? join(home, "burndown.json") });
    verbs.io.stdout(summary(report, writeOutputs(dir, report)));
    return EXIT.OK;
  } catch (error) {
    verbs.io.stderr(`error: ${errorMessage(error)}\n`);
    return EXIT.UNAVAILABLE;
  }
}

export function registerShadowCompare(dispatch: Command, verbs: Verbs): void {
  dispatch
    .command("shadow-compare")
    .description("score one day of shadow rows against the operator's real spawns; writes compare/<day>.json and the day's COMPARE.md section, nothing else")
    .option("--day <YYYY-MM-DD>", "the UTC day to compare")
    .option("--rule-file <path>", "the dispatcher rule file (default: dispatcher.json beside the factory config.json)")
    .option("--events-db <path>", "the agent-chat events database, opened read-only (default: $AGENT_CHAT_HOME/events.db)")
    .option("--ledger <path>", "the burndown dispatch ledger, read when present (default: $AGENT_CHAT_HOME/burndown.json)")
    .action(async (opts: CompareOptions) => verbs.setExit(await runShadowCompare(opts, verbs)));
}
