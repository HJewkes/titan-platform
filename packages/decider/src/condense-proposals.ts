import { contentKey, jaccard, tokenize, type Bullet, type PlaybookStore } from "@titan-design/memory";
import type { CiteDelta, IndexedDelta, ProposeDelta, RejectedCondenseDelta } from "./condense-deltas.js";
import { principleBullet } from "./principles.js";

/** Matches memory's curator, so a reworded restatement folds rather than becoming a second principle. */
const NEAR_DUP = 0.85;
const NEGATIONS = new Set(["never", "don", "dont", "not", "no", "avoid", "stop", "without"]);

function negations(text: string): string {
  return [...tokenize(text)].filter((t) => NEGATIONS.has(t)).sort().join(" ");
}

/** A restatement keeps polarity: a near-match that adds or drops a negation contradicts instead. */
function restates(rule: string, isNegative: boolean, bullet: Bullet): boolean {
  if (contentKey(rule) === contentKey(bullet.content)) return true;
  return bullet.isNegative === isNegative && negations(rule) === negations(bullet.content) && jaccard(rule, bullet.content) >= NEAR_DUP;
}

interface Proposal {
  index: number;
  delta: ProposeDelta;
}

/** Fold exact repeats in one output into the first, citing the union of their rows. */
function mergeRepeats(deltas: readonly IndexedDelta[]): Proposal[] {
  const byKey = new Map<string, Proposal>();
  for (const { index, delta } of deltas) {
    if (delta.type !== "propose") continue;
    const key = contentKey(delta.rule);
    const prior = byKey.get(key);
    const citedKeys = [...new Set([...(prior?.delta.citedKeys ?? []), ...delta.citedKeys])];
    byKey.set(key, { index: prior?.index ?? index, delta: { ...(prior?.delta ?? delta), citedKeys } });
  }
  return [...byKey.values()];
}

export interface ResolvedProposals {
  /** Restatements of a live principle in the batch's domain, as agreement from each cited row. */
  cites: CiteDelta[];
  added: string[];
}

function asAgreement(principleId: string, delta: ProposeDelta): CiteDelta[] {
  return delta.citedKeys.map((rowKey) => ({ type: "cite", rowKey, principleId, verdict: "agrees", reason: "restated by a proposal" }));
}

function isBlocked(playbook: PlaybookStore, rule: string): boolean {
  return playbook.blockedPatterns().some((b) => contentKey(b.pattern) === contentKey(rule) || jaccard(b.pattern, rule) >= NEAR_DUP);
}

/**
 * Turn proposals into new candidates or agreement citations. Feedback never comes from here, so
 * every helpful event still goes through `applyFeedback`, once per principle and ledger key.
 */
export function resolveProposals(playbook: PlaybookStore, domain: string, deltas: readonly IndexedDelta[], rejected: RejectedCondenseDelta[]): ResolvedProposals {
  const resolved: ResolvedProposals = { cites: [], added: [] };
  for (const { index, delta } of mergeRepeats(deltas)) {
    const isNegative = delta.isNegative ?? false;
    const twin = playbook.list().find((b) => restates(delta.rule, isNegative, b));
    if (isBlocked(playbook, delta.rule)) rejected.push({ domain, index, reason: "rule matches a blocked pattern" });
    else if (twin !== undefined && twin.category !== domain) {
      rejected.push({ domain, index, reason: `rule restates principle ${twin.id} in domain ${twin.category}` });
    } else if (twin !== undefined) resolved.cites.push(...asAgreement(twin.id, delta));
    else resolved.added.push(playbook.add(principleBullet({ rule: delta.rule, domain, citedKeys: delta.citedKeys, isNegative, reasoning: delta.reasoning })).id);
  }
  return resolved;
}
