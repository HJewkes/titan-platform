import { existsSync } from 'node:fs';
import { readWeekRows, type WeekRow } from '@titan-design/session-analytics';
import { openDatabase } from '@titan-design/store-sqlite';
import { shiftWeek } from './iso-week.js';
import type { ScorecardReading } from './sheet.js';

function initiativeMetrics(rows: readonly WeekRow[], initiative: string, week: string): Record<string, number | null> {
  const row = rows.find((cell) => cell.isoWeek === week && cell.dimension === 'initiative' && cell.key === initiative);
  return row === undefined ? {} : { ...row.metrics };
}

/** The initiative's scorecard figures for a week against the week before; a figure absent from both weeks is left out. */
export function scorecardReadings(rows: readonly WeekRow[], initiative: string, week: string): ScorecardReading[] {
  const current = initiativeMetrics(rows, initiative, week);
  const previous = initiativeMetrics(rows, initiative, shiftWeek(week, -1));
  const metrics = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  return metrics.map((metric) => ({ metric, previous: previous[metric] ?? null, current: current[metric] ?? null }));
}

/** Week rows from the scorecard store, opened read-only; a host with no store yet has no rows. */
export function readScorecardRows(storeFile: string): WeekRow[] {
  if (!existsSync(storeFile)) return [];
  const db = openDatabase(storeFile, { readonly: true });
  try {
    return readWeekRows(db);
  } finally {
    db.close();
  }
}
