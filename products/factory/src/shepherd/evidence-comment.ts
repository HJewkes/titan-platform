import { createHash } from "node:crypto";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import type { EvidenceRecord } from "./merge-facts.js";

export const VISUAL_REASON_PREFIX = "the owner decides visual changes: ";

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
  return Number.isInteger(value) ? (value as number) : undefined;
}

type PartialLocator = { source?: { conversation?: { nativeId?: string } }; evidence?: { line?: { byteOffset?: number }; subrecord?: { index?: number } }; selector?: { textIndex?: number } };

/** Enough to find the message in the local store: the session, the record offset, the part, and a hash that checks the full locator. */
export function locatorReference(locator: SourceTextLocator): LocatorReference {
  const { source, evidence, selector }: PartialLocator = locator;
  const position = { byteOffset: integer(evidence?.line?.byteOffset), subrecordIndex: integer(evidence?.subrecord?.index), textIndex: integer(selector?.textIndex) };
  const nativeId: unknown = source?.conversation?.nativeId;
  return {
    sessionId: typeof nativeId === "string" && SESSION_ID.test(nativeId) ? nativeId : "unknown",
    ...Object.fromEntries(Object.entries(position).filter(([, value]) => value !== undefined)),
    // The hash covers JSON.stringify in the locator's own key order, so only the reader that produced it can recompute it.
    locatorSha256: createHash("sha256").update(JSON.stringify(locator)).digest("hex"),
  };
}

const OUTCOME_WORD = { allow: "merged", gate: "gated", deny: "refused" } as const;

/** What each guard row says in words; an authority row has no entry and is shown by its id. */
const GUARD_RULE_WORDS: Record<string, string> = {
  "no-facts": "no merge facts were collected",
  "head-mismatch": "the facts were collected at another head",
  "files-unread": "the changed files could not be read",
  "visual-path": "the pull request changes visual paths",
  "required-checks-unknown": "the base branch's required checks could not be read",
  "merge-state-unsettled": "GitHub had not computed mergeability",
};

const LONG_PATH_LIST = 5;

function ruleInWords(rule: PolicyRule): string {
  return (rule.table === "shepherd-merge-guard" ? GUARD_RULE_WORDS[rule.rowId] : undefined) ?? `${rule.table}/${rule.rowId}`;
}

/** The paths the visual-path gate named, read back from its own reason, with the count it left out. */
function gatedPaths(decision: GateDecision): { paths: string[]; omitted: number } | undefined {
  if (decision.rule.rowId !== "visual-path" || !decision.reason.startsWith(VISUAL_REASON_PREFIX)) return undefined;
  const list = decision.reason.slice(VISUAL_REASON_PREFIX.length);
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

/** Readable summary first, then the full record, unchanged, collapsed; the marker stays on the first line. */
export function evidenceComment(record: EvidenceRecord): string {
  const { decision } = record;
  const gated = gatedPaths(decision);
  const reason = gated ? GUARD_RULE_WORDS["visual-path"]! : decision.reason;
  const carried = record.carry ? [``, `Carried the MERGE reviewed at \`${record.carry.fromHead}\` by ${record.carry.rule ?? "tree-equal"} (merge-tree \`${record.carry.mergeTree}\`) to a head whose tree is \`${record.carry.headTree}\`.`] : [];
  const rule = decision.outcome === "allow" ? [] : ["", `Rule: ${ruleInWords(decision.rule)} (${decision.rule.table}/${decision.rule.rowId}).`];
  const posted = { ...record, verdictLocator: locatorReference(record.verdictLocator) };
  return [
    evidenceMarker(record.head),
    "",
    `**Shepherd ${OUTCOME_WORD[decision.outcome]}** at \`${shortSha(record.head)}\`: ${reason}`,
    ...carried,
    "",
    ...checksTable(record),
    ...rule,
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

