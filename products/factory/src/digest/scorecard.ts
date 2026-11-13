import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { factoryHealthSchema, isoWeek, readWeekRows, type FactoryHealth } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { factoryHealthLine } from "./factory-health.js";

/** The ticket scorecard's store and the frozen week files the job writes beside it (TP-5446). */
export interface ScorecardPaths {
  storeFile: string;
  weeksDir: string;
}

/** `TITAN_SCORECARD_STORE`, else `$XDG_DATA_HOME/titan-scorecard/scorecard.sqlite3`, as session-miner's job resolves it. */
export function scorecardPaths(env: NodeJS.ProcessEnv, home: string = os.homedir()): ScorecardPaths {
  const raw = env.TITAN_SCORECARD_STORE ?? path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "titan-scorecard", "scorecard.sqlite3");
  const storeFile = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  return { storeFile, weeksDir: path.join(path.dirname(storeFile), "weeks") };
}

const measured = z.number().nullable();

/** The six headline figures, plus the inferred share that says whether two of them rest on inferred labels. */
const headline = z.object({
  dispatched: z.number(),
  merged: z.number(),
  upkeepShare: measured,
  ownerSourcedShare: measured,
  leadDispatchMergeMedianH: measured,
  costPerMerged: measured,
  inferredShare: measured,
});
type ScorecardHeadline = z.infer<typeof headline>;

/** A week frozen before TP-5446 S18 has no `factoryHealth`. */
const frozenWeek = z.object({
  isoWeek: z.string(),
  cells: z.array(z.object({ dimension: z.string(), metrics: headline, redFlags: z.array(z.string()) })),
  factoryHealth: factoryHealthSchema.nullable().optional(),
});

/**
 * `weekly` is the first digest after a weekly close: the closed week's headline, from its frozen file alone. Every
 * other slot is `open`, one line on the week so far. A null headline means nothing was measured, never zero.
 */
export type ScorecardSection =
  | { slot: "weekly"; isoWeek: string; headline: ScorecardHeadline | null; redFlags: string[]; factoryHealth: FactoryHealth | null }
  | { slot: "open"; isoWeek: string; headline: ScorecardHeadline | null; reason?: string };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The closed week's frozen file when the close wrote it inside this digest's window; null otherwise. */
function closedThisWindow(weeksDir: string, week: string, since: Date): string | null {
  const file = path.join(weeksDir, `${week}.json`);
  return existsSync(file) && statSync(file).mtimeMs >= since.getTime() ? file : null;
}

function weeklySection(file: string, week: string): ScorecardSection {
  const frozen = frozenWeek.parse(JSON.parse(readFileSync(file, "utf8")));
  const all = frozen.cells.find((cell) => cell.dimension === "all");
  return { slot: "weekly", isoWeek: week, headline: all?.metrics ?? null, redFlags: all?.redFlags ?? [], factoryHealth: frozen.factoryHealth ?? null };
}

function openSection(storeFile: string, week: string): ScorecardSection {
  if (!existsSync(storeFile)) return { slot: "open", isoWeek: week, headline: null, reason: "no scorecard store on this host" };
  const db = openDatabase(storeFile, { readonly: true, foreignKeys: false });
  try {
    const all = readWeekRows(db).find((row) => row.isoWeek === week && row.dimension === "all");
    return { slot: "open", isoWeek: week, headline: all?.metrics ?? null };
  } finally {
    db.close();
  }
}

/** Read only: the weekly slot reads the frozen file and never the store, so the digest shows what was frozen even if a rebuild drifted. */
export function readScorecard({ storeFile, weeksDir }: ScorecardPaths, now: Date, since: Date): ScorecardSection {
  const closed = isoWeek(new Date(now.getTime() - WEEK_MS).toISOString());
  const file = closedThisWindow(weeksDir, closed, since);
  return file === null ? openSection(storeFile, isoWeek(now.toISOString())) : weeklySection(file, closed);
}

const NOT_MEASURED = "not measured";
const share = (value: number | null): string => (value === null ? NOT_MEASURED : `${Math.round(value * 100)}%`);
const inferredMark = (h: ScorecardHeadline): string => (h.inferredShare !== null && h.inferredShare > 0 ? " (inferred labels)" : "");

const FLAG_TEXT: Readonly<Record<string, string>> = {
  "upkeep-cap": "upkeep over cap",
  "owner-floor": "owner share under floor",
  "rule-agreement": "rule agreement low",
  cost: "cost per merge over cap",
};

function headlineLines(h: ScorecardHeadline): string[] {
  return [
    `- Dispatched: ${h.dispatched}`,
    `- Merged: ${h.merged}`,
    `- Upkeep share: ${share(h.upkeepShare)}${inferredMark(h)}`,
    `- Owner-sourced: ${share(h.ownerSourcedShare)}${inferredMark(h)}`,
    `- Dispatch to merge, median: ${h.leadDispatchMergeMedianH === null ? NOT_MEASURED : `${h.leadDispatchMergeMedianH}h`}`,
    `- Cost per merged task: ${h.costPerMerged === null ? NOT_MEASURED : `$${h.costPerMerged.toFixed(2)}`}`,
  ];
}

function openLine(s: Extract<ScorecardSection, { slot: "open" }>): string {
  const h = s.headline;
  if (h === null) return `Ticket scorecard ${s.isoWeek} so far: ${NOT_MEASURED}${s.reason === undefined ? "" : ` (${s.reason})`}.`;
  return `Ticket scorecard ${s.isoWeek} so far: ${h.dispatched} dispatched, ${h.merged} merged, upkeep ${share(h.upkeepShare)}${inferredMark(h)}.`;
}

/** The weekly slot gets its own heading, red flags, six numbers and the factory health line; every other slot gets the one line. */
export function scorecardLines(s: ScorecardSection | undefined): string[] {
  if (s === undefined) return [];
  if (s.slot === "open") return ["", openLine(s)];
  const red = s.redFlags.length === 0 ? "none" : s.redFlags.map((flag) => FLAG_TEXT[flag] ?? flag).join(", ");
  const body = s.headline === null ? [`No task was dispatched in ${s.isoWeek}.`] : headlineLines(s.headline);
  return ["", `## Ticket scorecard ${s.isoWeek}`, `Red flags: ${red}`, ...body, factoryHealthLine(s.factoryHealth)];
}
