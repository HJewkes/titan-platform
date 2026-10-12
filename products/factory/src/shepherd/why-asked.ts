/**
 * Why a pending approve-merge reaches the owner, in one plain sentence, labelled deliberate (a stop the owner chose) or
 * accidental (a gate a fix would remove). The owner PR section quotes it under "Why it reaches you" (TP-1687 plan 4.3).
 */
import type { MergeGuardRow } from "./merge-facts.js";
import type { OwnerGateReason } from "./policy.js";
import { transientOnlyConditions } from "./resync.js";
import { ESCALATIONS } from "./route-table.js";

type GateClass = "deliberate" | "accidental" | "unclassified";

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

type Row = { gateClass: GateClass; words: string };

const GUARD_ROWS: Readonly<Record<MergeGuardRow, Row>> = {
  "visual-path": { gateClass: "deliberate", words: "Gate 2 visual: it changes a file the seat lists as rendered UI" },
  "merge-state-unsettled": { gateClass: "accidental", words: "GitHub had not finished computing mergeability on any read (transient merge-state read)" },
  "no-facts": { gateClass: "accidental", words: "Shepherd collected no merge facts at this head" },
  "head-mismatch": { gateClass: "accidental", words: "the merge facts were collected at another head" },
  "files-unread": { gateClass: "accidental", words: "Shepherd could not read the changed files" },
  "required-checks-unknown": { gateClass: "accidental", words: "Shepherd could not read which checks are required" },
};

/** The gate rows of `release.ts` and the factory's catch-all default, keyed `table/row`. */
const OTHER_ROWS: Readonly<Record<string, Row>> = {
  "shepherd-release/owner-gate": { gateClass: "deliberate", words: "npm publish: the seat's policy has a release PR wait for you" },
  "shepherd-release/no-preflight": { gateClass: "accidental", words: "no release preflight ran at this head" },
  "shepherd-release/preflight-blocked": { gateClass: "accidental", words: "the release preflight found blockers, so the release cannot land yet" },
  "factory-default/gate-all": { gateClass: "accidental", words: "no gate policy was configured for this run, so the factory's default gates every action" },
};

/** What a recorded mergeable_state says about a merge-tree-clean that read false; `unknown` alone is a transient read. */
const MERGE_STATE_WORDS: Readonly<Record<string, Row>> = {
  unknown: { gateClass: "accidental", words: "GitHub was still recomputing mergeability (mergeable_state unknown), so `merge-tree-clean` read false; TP-1688 settles this transient merge-state read" },
  dirty: { gateClass: "deliberate", words: "the PR conflicts with its base (mergeable_state dirty)" },
  behind: { gateClass: "deliberate", words: "the branch is behind its base (mergeable_state behind)" },
  blocked: { gateClass: "deliberate", words: "GitHub blocks the merge and the block is not a bypassable review rule (mergeable_state blocked)" },
  draft: { gateClass: "deliberate", words: "the PR is a draft" },
};

function rowWhy(ruleId: string, row: Row): WhyAsked {
  return { gateClass: row.gateClass, ruleId, sentence: `${row.gateClass === "deliberate" ? "By design" : "Not by design"}: ${row.words} (${row.gateClass}).` };
}

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
  if (ownerGateReason === undefined) return { gateClass: "accidental", ruleId, sentence: `Seat ${rowId} policy is owner-gate with no recorded reason: the seat lacks the merge grant for this repo, or the run was registered before a reason was required (accidental: no reason recorded).` };
  const gateClass = ownerGateReason === "proof-fixture" ? "accidental" : "deliberate";
  return { gateClass, ruleId, sentence: `By design: ${OWNER_GATE_WORDS[ownerGateReason]} (${gateClass}, reason ${ownerGateReason}).` };
}

function guardWhy(rowId: string, reason: string): WhyAsked {
  const ruleId = `shepherd-merge-guard/${rowId}`;
  const row = (GUARD_ROWS as Readonly<Record<string, Row>>)[rowId];
  return row ? rowWhy(ruleId, row) : { gateClass: "unclassified", ruleId, sentence: `A Shepherd merge guard stopped the merge: ${reason}.` };
}

/**
 * The unmet conditions of the MRG-AU row that came closest to allowing, from `<ROW> unmet: a, b; <ROW> unmet: c`; a gate
 * reason lists every allow row, and the closest one is what the owner would have to change.
 */
export function closestUnmet(reason: string): string[] {
  const rows = [...reason.matchAll(/MRG-AU-[A-Z]+ unmet: ([^;]+)/g)].map((match) => (match[1] ?? "").split(", ").map((c) => c.trim()));
  return rows.reduce<string[]>((closest, row) => (closest.length === 0 || row.length < closest.length ? row : closest), []);
}

/**
 * merge-tree-clean also reads false for a conflict, a branch behind its base or a moved head, so only the mergeable_state
 * the evidence recorded tells a transient read from a real block; without it the gate stays unclassified.
 */
function mergeTreeWhy(rowId: string, mergeableState: string | undefined): WhyAsked {
  if (mergeableState === undefined) {
    return { gateClass: "unclassified", ruleId: rowId, sentence: "Authority gated because `merge-tree-clean` read false, and the evidence recorded no mergeable_state, so a transient read cannot be told from a conflict." };
  }
  const row = MERGE_STATE_WORDS[mergeableState] ?? { gateClass: "accidental", words: `GitHub reported mergeable_state ${mergeableState} but had no test merge at this head, so the head moved or the test merge was not built yet` };
  return rowWhy(rowId, row);
}

function authorityWhy(rowId: string, reason: string, mergeableState: string | undefined): WhyAsked {
  if (transientOnlyConditions(reason).join() === "merge-tree-clean") return mergeTreeWhy(rowId, mergeableState);
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

interface GateContext {
  ownerGateReason?: OwnerGateReason;
  /** The mergeable_state the merge evidence judged (TP-1688), which tells a transient merge-tree read from a conflict. */
  mergeableState?: string;
}

/** Every gate rule maps to one sentence; a rule this map does not know is labelled unclassified, which lintPrSection refuses. */
export function whyAsked(rule: GateRuleRef, reason: string, context: GateContext = {}): WhyAsked {
  const other = OTHER_ROWS[`${rule.table}/${rule.rowId}`];
  if (other) return rowWhy(`${rule.table}/${rule.rowId}`, other);
  switch (rule.table) {
    case "shepherd-seat":
      return seatWhy(rule.rowId, context.ownerGateReason);
    case "shepherd-merge-guard":
      return guardWhy(rule.rowId, reason);
    case "authority":
      return authorityWhy(rule.rowId, reason, context.mergeableState);
    case "shepherd-route":
      return routeWhy(rule.rowId, reason);
    default:
      return { gateClass: "unclassified", ruleId: `${rule.table}/${rule.rowId}`, sentence: `Gate rule ${rule.table}/${rule.rowId} stopped the merge: ${reason}.` };
  }
}
