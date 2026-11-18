import type { Bet, Task } from "@titan-design/pm";
import type { LiveSourceOptions } from "@titan-design/rpc-client";
import { readShadowEligibility } from "../active-work.js";
import type { SelectionPolicy } from "../intake.js";
import type { Eligibility } from "../rules.js";
import type { SheetBasis } from "./sheet-basis.js";
import { readSheetEligibility, type SheetQuery } from "./sheet-eligibility.js";
import type { SheetSource } from "./sheet-source.js";

/** The lane's sheet could not be read, so its basis is unknown; the tick refuses the lane rather than judge it against nothing. */
export class SheetUnread extends Error {}

export interface BasisRead {
  result: Eligibility;
  planRead: "rpc" | "file";
  basis: "selected" | "proposed-sheet";
}

interface BasisContext {
  activeRoot: string;
  policyFor: (tasks: readonly Task[]) => Promise<SelectionPolicy>;
  lane: { initiative: string; tag: string | null };
  sheets?: SheetSource;
}

/** The lane judged against its selected bets, or against its sheet's proposed bets while the store selects none this week. */
export async function readLaneBasis(source: LiveSourceOptions, query: SheetQuery, context: BasisContext): Promise<BasisRead> {
  const { sheets, lane } = context;
  if (sheets !== undefined) {
    const seen: { basis?: SheetBasis } = {};
    const sheetBets = (): readonly Bet[] => {
      const basis = sheets.basisFor(lane, query.week);
      seen.basis = basis;
      if (basis.kind === "unread") throw new SheetUnread(basis.detail);
      return basis.kind === "sheet" ? basis.bets : [];
    };
    const read = await readSheetEligibility(source, query, context, sheetBets);
    if (read !== undefined) return { ...read, basis: seen.basis?.kind === "sheet" ? "proposed-sheet" : "selected" };
  }
  return { ...(await readShadowEligibility(source, query, context)), basis: "selected" };
}
