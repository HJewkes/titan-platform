import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FactoryHealth, PhaseWeek, WeekRow } from "@titan-design/session-analytics";

export interface FreezeResult {
  /** Closed weeks frozen by this run. */
  frozen: string[];
  /** Closed weeks whose recomputed figures differ from their frozen file; the file is kept and the new figures go beside it. */
  drift: string[];
  filesWritten: number;
}

/** What a week file holds: the weekly cells, the Shepherd phase medians and the "Factory health" group. */
export interface StoredWeeks {
  cells: readonly WeekRow[];
  phases: readonly PhaseWeek[];
  health: readonly FactoryHealth[];
}

function weekFile({ cells, phases, health }: StoredWeeks, week: string, withHealth: boolean): string {
  const body = { isoWeek: week, cells: cells.filter((c) => c.isoWeek === week), phases: phases.filter((p) => p.isoWeek === week) };
  const factoryHealth = health.find((h) => h.isoWeek === week) ?? null;
  return `${JSON.stringify(withHealth ? { ...body, factoryHealth } : body, null, 2)}\n`;
}

/** A week frozen before the group existed (TP-5446 S18) still matches when its own figures do: the group is not drift. */
function matchesFrozen(text: string, stored: StoredWeeks, week: string, content: string): boolean {
  return text === content || text === weekFile(stored, week, false);
}

function writeIfChanged(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  writeFileSync(file, content);
  return true;
}

/**
 * Freeze every closed ISO week (before `currentWeek`) to `weeks/<week>.json` once. A closed week that later computes
 * differently is drift: the frozen file is never overwritten, and the new figures are written to `<week>.drift.json`.
 */
export function freezeWeeks(dir: string, stored: StoredWeeks, currentWeek: string): FreezeResult {
  const result: FreezeResult = { frozen: [], drift: [], filesWritten: 0 };
  const weeks = [...new Set([...stored.cells.map((c) => c.isoWeek), ...stored.phases.map((p) => p.isoWeek)])].filter((w) => w < currentWeek).sort();
  if (weeks.length > 0) mkdirSync(dir, { recursive: true });
  for (const week of weeks) {
    const content = weekFile(stored, week, true);
    const frozen = path.join(dir, `${week}.json`);
    const drift = path.join(dir, `${week}.drift.json`);
    if (!existsSync(frozen)) {
      writeFileSync(frozen, content);
      result.frozen.push(week);
      result.filesWritten += 1;
    } else if (!matchesFrozen(readFileSync(frozen, "utf8"), stored, week, content)) {
      result.drift.push(week);
      if (writeIfChanged(drift, content)) result.filesWritten += 1;
    } else if (existsSync(drift)) {
      rmSync(drift);
      result.filesWritten += 1;
    }
  }
  return result;
}
