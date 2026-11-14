import { errorMessage } from "../../narrow.js";
import { sheetBasis, type SheetBasis } from "./sheet-basis.js";
import { readSheetDir, type SheetFile } from "./sheet-dir.js";

interface BetsRules {
  source: "selected" | "selected-then-sheet";
  sheetDir?: string;
  digestDir?: string;
  sheetWeek?: string;
}

export interface SheetSource {
  /** The rule file's sheet week, when it pins one: those sheets apply whatever the calendar week. */
  pinnedWeek?: string;
  basisFor: (lane: { initiative: string; tag: string | null }, calendarWeek: string) => SheetBasis;
}

/** Undefined unless the rule file falls back to sheets; the dir is read once per wake, and only when a lane asks. */
export function sheetSource(bets: BetsRules | undefined, read: (sheetDir: string, digestDir?: string) => SheetFile[] = readSheetDir): SheetSource | undefined {
  const sheetDir = bets?.sheetDir;
  if (bets?.source !== "selected-then-sheet" || sheetDir === undefined) return undefined;
  let files: SheetFile[] | { unread: string } | undefined;
  const load = () => {
    try {
      files ??= read(sheetDir, bets.digestDir);
    } catch (error) {
      files = { unread: `bet sheet dir: ${errorMessage(error)}` };
    }
    return files;
  };
  const weekFor = (calendarWeek: string) => bets.sheetWeek ?? calendarWeek;
  const basisFor: SheetSource["basisFor"] = (lane, calendarWeek) => {
    const loaded = load();
    return "unread" in loaded ? { kind: "unread", detail: loaded.unread } : sheetBasis(loaded, { ...lane, week: weekFor(calendarWeek) });
  };
  return { basisFor, ...(bets.sheetWeek !== undefined && { pinnedWeek: bets.sheetWeek }) };
}
