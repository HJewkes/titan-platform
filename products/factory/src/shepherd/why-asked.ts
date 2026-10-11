/**
 * Why a pending approve-merge reaches the owner, in one plain sentence, labelled deliberate (a stop the owner chose) or
 * accidental (a gate a fix would remove). The owner PR section quotes it under "Why it reaches you" (TP-1687 plan 4.3).
 */
import type { OwnerGateReason } from "./policy.js";
import { transientOnlyConditions } from "./resync.js";
import { ESCALATIONS } from "./route-table.js";

export type GateClass = "deliberate" | "accidental" | "unclassified";

export interface GateRuleRef {
  table: string;
  rowId: string;
}

export interface WhyAsked {
  gateClass: GateClass;
  /** `table/row`, or the authority row id, as the owner reads it in backticks. */
  ruleId: string;
  sentence: string;
}

const OWNER_GATE_WORDS: Readonly<Record<OwnerGateReason, string>> = {
  "gate-2-visual": "Gate 2 visual sign-off: the seat registered this UI change to wait for you",
  "g10-security": "a security posture change the seat registered to wait for you",
  "proof-fixture": "a proof fixture registered to wait for you on purpose; it belongs in no owner round",
  "owner-asked": "you asked to decide this PR yourself",
};

const GUARD_ROWS: Readonly<Record<string, { gateClass: GateClass; words: string }>> = {
  "github-path": { gateClass: "deliberate", words: "you decide every change under .github/ (TP-1691 and TP-1692 would narrow this to non-benign workflow diffs)" },
  "visual-path": { gateClass: "deliberate", words: "Gate 2 visual: it changes a file the seat lists as rendered UI" },
  "merge-state-unsettled": { gateClass: "accidental", words: "GitHub had not finished computing mergeability on any read (transient merge-state read)" },
  "no-facts": { gateClass: "accidental", words: "Shepherd collected no merge facts at this head" },
  "head-mismatch": { gateClass: "accidental", words: "the merge facts were collected at another head" },
  "files-unread": { gateClass: "accidental", words: "Shepherd could not read the changed files" },
  "required-checks-unknown": { gateClass: "accidental", words: "Shepherd could not read which checks are required" },
};

const CONDITION_WORDS: Readonly<Record<string, string>> = {
  "resolver-is-dispatched-reviewer": "the verdict did not come from the dispatched reviewer",
  "verdict-merge-at-head": "there is no MERGE verdict at this head",
  "required-contexts-green": "a required check is not green",
  "no-non-green-run": "a check run is not green",
  "merge-tree-clean": "the test merge was not clean",
  "repo-not-frozen": "the repo is frozen",
  "no-protected-path-change": "it changes a protected path such as .github/",
  "seat-grants-merge-on-green-approve": "the seat lacks the merge-on-green-approve grant",
};

function seatWhy(rowId: string, ownerGateReason: OwnerGateReason | undefined): WhyAsked {
  const ruleId = `shepherd-seat/${rowId}`;
  if (ownerGateReason === undefined) return { gateClass: "accidental", ruleId, sentence: `Seat ${rowId} has no merge grant for this repo, so every merge waits for you (accidental: a stale default).` };
  const gateClass = ownerGateReason === "proof-fixture" ? "accidental" : "deliberate";
  return { gateClass, ruleId, sentence: `By design: ${OWNER_GATE_WORDS[ownerGateReason]} (${gateClass}, reason ${ownerGateReason}).` };
}

function guardWhy(rowId: string, reason: string): WhyAsked {
  const ruleId = `shepherd-merge-guard/${rowId}`;
  const row = GUARD_ROWS[rowId];
  if (!row) return { gateClass: "unclassified", ruleId, sentence: `A Shepherd merge guard stopped the merge: ${reason}.` };
  return { gateClass: row.gateClass, ruleId, sentence: `${row.gateClass === "deliberate" ? "By design" : "Not by design"}: ${row.words} (${row.gateClass}).` };
}

/**
 * The unmet conditions of the MRG-AU row that came closest to allowing, from `<ROW> unmet: a, b; <ROW> unmet: c`; a gate
 * reason lists every allow row, and the closest one is what the owner would have to change.
 */
export function closestUnmet(reason: string): string[] {
  const rows = [...reason.matchAll(/MRG-AU-[A-Z]+ unmet: ([^;]+)/g)].map((match) => (match[1] ?? "").split(", ").map((c) => c.trim()));
  return rows.reduce<string[]>((closest, row) => (closest.length === 0 || row.length < closest.length ? row : closest), []);
}

function authorityWhy(rowId: string, reason: string): WhyAsked {
  if (transientOnlyConditions(reason).join() === "merge-tree-clean") {
    const sentence = "Not by design: when Shepherd judged the merge, GitHub was still recomputing mergeability, so `merge-tree-clean` read false and authority could only gate (accidental: transient merge-state read; TP-1688 fixes it).";
    return { gateClass: "accidental", ruleId: rowId, sentence };
  }
  const unmet = closestUnmet(reason);
  if (unmet.length === 0) return { gateClass: "unclassified", ruleId: rowId, sentence: `Authority did not allow an automated merge: ${reason}.` };
  const words = unmet.map((c) => CONDITION_WORDS[c] ?? `\`${c}\` is unmet`).join("; ");
  return { gateClass: "deliberate", ruleId: rowId, sentence: `By design, authority holds the merge for you because ${words} (deliberate).` };
}

function routeWhy(rowId: string, reason: string): WhyAsked {
  const ruleId = `shepherd-route/${rowId}`;
  const known = (ESCALATIONS as Readonly<Record<string, string>>)[rowId];
  if (known === undefined) return { gateClass: "unclassified", ruleId, sentence: `Shepherd escalated the run: ${reason}.` };
  const words = rowId === "policy-denial" ? reason : known;
  return { gateClass: "accidental", ruleId, sentence: `Not by design: Shepherd's review loop stopped because ${words} (accidental: the loop ran out before a mergeable verdict).` };
}

/** Every gate rule maps to one sentence; a rule this map does not know is labelled unclassified, which lintPrSection refuses. */
export function whyAsked(rule: GateRuleRef, reason: string, ownerGateReason?: OwnerGateReason): WhyAsked {
  switch (rule.table) {
    case "shepherd-seat":
      return seatWhy(rule.rowId, ownerGateReason);
    case "shepherd-merge-guard":
      return guardWhy(rule.rowId, reason);
    case "authority":
      return authorityWhy(rule.rowId, reason);
    case "shepherd-route":
      return routeWhy(rule.rowId, reason);
    default:
      return { gateClass: "unclassified", ruleId: `${rule.table}/${rule.rowId}`, sentence: `Gate rule ${rule.table}/${rule.rowId} stopped the merge: ${reason}.` };
  }
}
