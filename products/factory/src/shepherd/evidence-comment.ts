import { createHash } from "node:crypto";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { oneLine } from "../gate-brief.js";
import type { EvidenceRecord } from "./merge-facts.js";
import { VISUAL_DELTA_CAPS, VisualDeltaSchema } from "./review-schemas.js";
import type { VisualDelta } from "./visual-delta-read.js";
import { percent, wouldDecide } from "./visual-threshold-gate.js";
import { readPath } from "../narrow.js";

export const VISUAL_REASON_PREFIX = "the owner decides visual changes: ";
export const SKILL_REASON_PREFIX = "the owner reviews repo skill changes: ";
export const GITHUB_PATH_REASON_PREFIX = "a .github/ change needs the reviewer's CI-policy line: ";
export const CI_POLICY_WEAKENED_PREFIX = "CI-policy weakened: ";
export const CI_POLICY_MALFORMED_REASON = "the reviewer's CI-policy line is malformed or repeated, so it may hide a weakening";

/** One marker per head, so a replay or a second run at the same head finds the comment instead of posting again. */
export function evidenceMarker(head: string): string {
  return `<!-- shepherd-evidence:${head} -->`;
}

/** What a public PR comment may say about a verdict locator: no namespace, path or source id. */
interface LocatorReference {
  sessionId: string;
  byteOffset?: number;
  subrecordIndex?: number;
  textIndex?: number;
  locatorSha256: string;
}

const SESSION_ID = /^(?!\.\.$)[^/@\\%]{1,64}$/;

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Enough to find the message in the local store: the session, the record offset, the part, and a hash that checks the full locator. */
export function locatorReference(locator: SourceTextLocator): LocatorReference {
  const position = {
    byteOffset: integer(readPath(locator, "evidence", "line", "byteOffset")),
    subrecordIndex: integer(readPath(locator, "evidence", "subrecord", "index")),
    textIndex: integer(readPath(locator, "selector", "textIndex")),
  };
  const nativeId = readPath(locator, "source", "conversation", "nativeId");
  return {
    sessionId: typeof nativeId === "string" && SESSION_ID.test(nativeId) ? nativeId : "unknown",
    ...Object.fromEntries(Object.entries(position).filter(([, value]) => value !== undefined)),
    // The hash covers JSON.stringify in the locator's own key order, so only the reader that produced it can recompute it.
    locatorSha256: createHash("sha256").update(JSON.stringify(locator)).digest("hex"),
  };
}

const OUTCOME_WORD = { allow: "cleared to merge", gate: "gated", deny: "refused" } as const;

/** What each guard row says in words; an authority row has no entry and is shown by its id. */
const GUARD_RULE_WORDS: Record<string, string> = {
  "no-facts": "no merge facts were collected",
  "head-mismatch": "the facts were collected at another head",
  "files-unread": "the changed files could not be read",
  "visual-path": "the pull request changes visual paths",
  "skill-path": "the pull request changes repo skills",
  "required-checks-unknown": "the base branch's required checks could not be read",
  "merge-state-unsettled": "GitHub had not computed mergeability",
  "github-path": "a .github/ change has no CI-policy line from the reviewer",
  "ci-policy-weakened": "the reviewer says the change weakens CI policy",
  "ci-policy-malformed": "the reviewer's CI-policy line could not be read",
};

const LONG_PATH_LIST = 5;
/** Rows and paths past these stay in the machine evidence, so the comment stays under GitHub's 65,536-character limit. */
const SHOWN_SNAPSHOTS = 20;
const SHOWN_SENSITIVE = 10;
const MAX_SHADOW_LINE = 2_000;

function ruleInWords(rule: PolicyRule): string {
  return (rule.table === "shepherd-merge-guard" ? GUARD_RULE_WORDS[rule.rowId] : undefined) ?? `${rule.table}/${rule.rowId}`;
}

const PATH_GATE_PREFIXES: Record<string, string> = { "visual-path": VISUAL_REASON_PREFIX, "skill-path": SKILL_REASON_PREFIX, "github-path": GITHUB_PATH_REASON_PREFIX };

/** The paths a path gate named, read back from its own reason, with the count it left out. */
function gatedPaths(decision: GateDecision): { paths: string[]; omitted: number } | undefined {
  const prefix = decision.rule.table === "shepherd-merge-guard" ? PATH_GATE_PREFIXES[decision.rule.rowId] : undefined;
  if (prefix === undefined || !decision.reason.startsWith(prefix)) return undefined;
  const list = decision.reason.slice(prefix.length);
  const more = /^(.*) and (\d+) more$/.exec(list);
  return { paths: (more?.[1] ?? list).split(", "), omitted: more ? Number(more[2]) : 0 };
}

function pathsSection(decision: GateDecision): string[] {
  const gated = gatedPaths(decision);
  if (!gated) return [];
  const items = gated.paths.map((path) => `- \`${path}\``);
  if (gated.omitted > 0) items.push(`- and ${gated.omitted} more`);
  if (items.length <= LONG_PATH_LIST) return ["", ...items];
  return ["", `<details><summary>${gated.paths.length + gated.omitted} paths</summary>`, "", ...items, "", "</details>"];
}

function checksTable(record: EvidenceRecord): string[] {
  const rows = record.checkRuns.map((run) => `| ${run.name} | ${run.conclusion ?? "pending"} |`);
  return ["| Check | Conclusion |", "| --- | --- |", ...rows, `| Reviewer verdict | MERGE at \`${shortSha(record.carry?.fromHead ?? record.head)}\` |`];
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

type Shot = VisualDelta["snapshots"][number];

/** A PR names its own snapshot paths, so a cell is flattened and its pipes escaped to keep the table whole. */
const cell = (text: string): string => oneLine(text, VISUAL_DELTA_CAPS.text).replaceAll("|", "\\|");

function changeCell(shot: Shot): string {
  if (shot.status === "changed") return shot.share === undefined ? "no share recorded" : percent(shot.share);
  return shot.status === "unmeasured" ? `unmeasured: ${shot.reason ?? "no reason recorded"}` : shot.status;
}

/** Matches the `on` decision: a changed shot with no share is over, and a removed or unmeasured one fails closed. */
function overCell(shot: Shot, maxChangedShare: number): string {
  if (shot.status === "added") return "no";
  if (shot.status === "changed") return (shot.share ?? 1) > maxChangedShare ? "yes" : "no";
  return "fails closed";
}

/** The largest change in each component leads its group, so each group's first row is its maximum. */
function snapshotTable({ snapshots, policy, omitted }: VisualDelta): string[] {
  if (snapshots.length === 0) return ["No snapshot changed."];
  const shown = snapshots.slice(0, SHOWN_SNAPSHOTS).sort((a, b) => a.component.localeCompare(b.component) || (b.share ?? 0) - (a.share ?? 0));
  const rows = shown.map((shot, i) => {
    const component = shown[i - 1]?.component === shot.component ? "" : cell(shot.component);
    return `| ${component} | \`${cell(shot.path)}\` | ${cell(changeCell(shot))} | ${overCell(shot, policy.maxChangedShare)} |`;
  });
  const left = snapshots.length - shown.length + (omitted?.snapshots ?? 0);
  const table = ["| Component | Snapshot | Change | Over? |", "| --- | --- | --- | --- |", ...rows, ...(left > 0 ? ["", `and ${left} more snapshots`] : [])];
  return snapshots.length <= LONG_PATH_LIST ? table : [`<details><summary>${snapshots.length + (omitted?.snapshots ?? 0)} snapshots</summary>`, "", ...table, "", "</details>"];
}

function sensitiveLines(delta: VisualDelta): string[] {
  const kinds = [["Public API", "api"], ["Tokens", "tokens"], ["Visual harness", "harness"]] as const;
  return kinds.map(([label, key]) => {
    const more = Math.max(0, delta[key].length - SHOWN_SENSITIVE) + (delta.omitted?.[key] ?? 0);
    const named = [...delta[key].slice(0, SHOWN_SENSITIVE).map((path) => `\`${cell(path)}\``), ...(more > 0 ? [`and ${more} more`] : [])];
    return `- ${label}: ${named.length === 0 ? "none changed" : named.join(", ")}`;
  });
}

/** TP-4320 §6: what the visual threshold measured at this head, and in shadow what `on` would have made of it. */
function visualDiffSection(delta: VisualDelta | undefined): string[] {
  if (delta === undefined) return [];
  if (!VisualDeltaSchema.safeParse(delta).success) return ["", "**Visual diff**: the recorded delta is malformed, so it reads as unmeasured."];
  const { mode, maxChangedShare, pixelTolerance } = delta.policy;
  const base = delta.mergeBase === null ? "no merge base read" : `merge base \`${shortSha(delta.mergeBase)}\``;
  const head = `**Visual diff** (${mode}): threshold ${percent(maxChangedShare)} of the content box, pixel tolerance ${pixelTolerance}, ${base}.`;
  const shadow = mode === "shadow" ? ["", `Shadow: under "on" this head's visual delta would ${oneLine(wouldDecide(delta), MAX_SHADOW_LINE)}.`] : [];
  if (delta.unread !== undefined) return ["", head, "", `The changed files could not be read: ${oneLine(delta.unread, VISUAL_DELTA_CAPS.text)}.`, ...shadow];
  return ["", head, "", ...snapshotTable(delta), "", ...sensitiveLines(delta), ...shadow];
}

function carriedLine({ carry }: EvidenceRecord): string[] {
  if (!carry) return [];
  return ["", `Carried the MERGE reviewed at \`${carry.fromHead}\` by ${carry.rule ?? "tree-equal"} (merge-tree \`${carry.mergeTree}\`) to a head whose tree is \`${carry.headTree}\`.`];
}

/** Names no actor: a merge someone else made is still a true "Merged" line. */
function mergedLine(merged: { mergeSha: string | null } | undefined): string[] {
  if (!merged) return [];
  return [merged.mergeSha === null ? "**Merged** (GitHub named no merge commit)." : `**Merged** at \`${shortSha(merged.mergeSha)}\`.`];
}

/**
 * Readable summary first, then the full record, unchanged, collapsed; the marker stays on the first line.
 * Only a caller that saw the merge land passes `merged`, so a head that never merged never reads as merged.
 */
export function evidenceComment(record: EvidenceRecord, merged?: { mergeSha: string | null }): string {
  const { decision } = record;
  const gated = gatedPaths(decision);
  const reason = gated ? ruleInWords(decision.rule) : decision.reason;
  const rule = decision.outcome === "allow" ? [] : ["", `Rule: ${ruleInWords(decision.rule)} (${decision.rule.table}/${decision.rule.rowId}).`];
  const proof = record.proofUnverified === undefined ? [] : ["", `Fix-proof unverified at this head: ${record.proofUnverified}.`];
  const posted = { ...record, verdictLocator: locatorReference(record.verdictLocator) };
  return [
    evidenceMarker(record.head),
    "",
    `**Shepherd ${OUTCOME_WORD[decision.outcome]}** at \`${shortSha(record.head)}\`: ${reason}`,
    ...mergedLine(merged),
    ...carriedLine(record),
    "",
    ...checksTable(record),
    ...visualDiffSection(record.visualDelta),
    ...rule,
    ...proof,
    ...pathsSection(decision),
    "",
    "<details><summary>Machine evidence</summary>",
    "",
    "```json",
    JSON.stringify(posted, null, 2),
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

