import type { Bet } from "@titan-design/pm";
import type { BetSheet, SheetBet, SheetScope } from "./bet-sheet.js";
import type { SheetFile } from "./sheet-dir.js";

/*
 * The proposed-sheet bet basis (TP-5755 S7): a lane with no selected bet this week is judged against its sheet's
 * proposed bets, in memory only. A sheet that fails to parse leaves the basis unread rather than silently empty.
 */

export type SheetBasis = { kind: "none" } | { kind: "sheet"; file: string; bets: Bet[] } | { kind: "unread"; detail: string };

interface LaneWeek {
  initiative: string;
  tag: string | null;
  week: string;
}

/** A failed sheet whose front matter is too broken to name its lane could be any lane's, so it counts against all of them. */
const mayCover = (scope: SheetScope, lane: LaneWeek): boolean =>
  (scope.initiative === undefined || scope.initiative === lane.initiative) && (scope.lane === undefined || scope.lane === lane.tag) && (scope.week === undefined || scope.week === lane.week);

/** A proposed bet as the selection rules read it; the sheet's name for it stands in for an id the plan store has not assigned. */
function asBet(sheet: BetSheet, bet: SheetBet): Bet {
  const { initiative, week } = sheet.front;
  // The rules never read the baseline, and a sheet may not know it yet; NaN keeps the unknown from reading as zero.
  const prediction = { ...bet.prediction, baseline: bet.prediction.baseline ?? Number.NaN };
  const named = { ...(bet.tasks !== undefined && { tasks: bet.tasks }), ...(bet.selector !== undefined && { selector: bet.selector }) };
  return { id: bet.id, initiative, week, outcome: bet.outcome, order: bet.order, ...named, prediction, state: "proposed", cites: bet.cites };
}

function failureDetail(file: string, errors: readonly { line: number; message: string }[]): string {
  const first = errors[0];
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return `bet sheet ${file} does not parse: line ${first?.line ?? 1}: ${first?.message ?? "unknown error"}${more}`;
}

/** The bets of the one sheet for this lane and week, in sheet order; none when no sheet is for it. */
export function sheetBasis(sheets: readonly SheetFile[], lane: LaneWeek): SheetBasis {
  const failed = sheets.find(({ result }) => !result.ok && mayCover(result.scope, lane));
  if (failed !== undefined && !failed.result.ok) return { kind: "unread", detail: failureDetail(failed.file, failed.result.errors) };
  const matching = sheets.flatMap(({ file, result }) => (result.ok && mayCover(result.sheet.front, lane) ? [{ file, sheet: result.sheet }] : []));
  if (matching.length > 1) return { kind: "unread", detail: `bet sheets ${matching.map((entry) => entry.file).join(", ")} all name this lane and week` };
  const [only] = matching;
  return only === undefined ? { kind: "none" } : { kind: "sheet", file: only.file, bets: only.sheet.bets.map((bet) => asBet(only.sheet, bet)) };
}
