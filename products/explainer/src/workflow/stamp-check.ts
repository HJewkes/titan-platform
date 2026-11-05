import type { LedgerStamp } from "../ledger-stamp.js";
import type { Check } from "./records.js";

/** Reported only, so a reader sees which `new_terms` the stage wrote rather than the model. */
export function stampCheck(stamps: readonly LedgerStamp[]): Check[] {
  if (stamps.length === 0) return [];
  const named = stamps.map((stamp) => `${stamp.beat} ${stamp.term}`).join(", ");
  return [{ name: "ledger-stamp", gate: false, pass: true, detail: `stamped new_terms on ${stamps.length} ledger item(s): ${named}` }];
}
