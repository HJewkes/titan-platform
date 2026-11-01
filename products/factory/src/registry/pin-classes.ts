/** v9.1 §2.3's pin classes; marker-table.ts's pin_class CHECK holds the same five. */
export const PIN_CLASSES = ["tree", "diff", "observed", "item", "landed"] as const;
export type PinClass = (typeof PIN_CLASSES)[number];

interface FactRule {
  pinClass: PinClass;
  /** The class on a visual item, where it differs: owner:approved is tree-pinned there and diff-pinned elsewhere. */
  visualPinClass?: PinClass;
  /** Observed facts only: the event kinds that reset the read. */
  producer?: readonly string[];
  /** Observed facts only: an ISO-8601 duration, for a read no event kind resets (C3). */
  ttl?: string;
}

/**
 * v9.1 §2.3's identity table, and the only place a fact's pin class is set (§2.7: a rule file).
 * A key is an exact fact name, or `<prefix>:*` for a family.
 */
const FACT_PIN_CLASS: Readonly<Record<string, FactRule>> = {
  "head:pushed": { pinClass: "tree" },
  "ci:green": { pinClass: "tree" },
  "proof:reproduced": { pinClass: "tree" },
  "gh:approved": { pinClass: "tree" },
  "candidate:*": { pinClass: "tree" },
  "owner:approved": { pinClass: "diff", visualPinClass: "tree" },
  "verdict:merge": { pinClass: "diff" },
  "adversary:merge": { pinClass: "diff" },
  "conformance:ok": { pinClass: "diff" },
  "attest:*": { pinClass: "diff" },
  hold: { pinClass: "observed", ttl: "PT5M" },
  roster: { pinClass: "observed", ttl: "PT5M" },
  mergeability: { pinClass: "observed", producer: ["HeadPushed", "BaseChanged", "MainMoved"] },
  "landing-state": { pinClass: "observed", producer: ["PRMerged", "PRClosed"] },
  "land-rules": { pinClass: "observed", producer: ["RulesChanged"] },
  "contract:approved": { pinClass: "item" },
  "plan:*": { pinClass: "item" },
  deployed: { pinClass: "item" },
  "fix:*": { pinClass: "item" },
  landed: { pinClass: "landed" },
};

/** Facts that take the pin of the fact they serve (§2.3): `claim:ci:green` is pinned as `ci:green`. */
const SERVING_PREFIXES = ["claim:", "redrive:"];

function servedFact(fact: string): string {
  const prefix = SERVING_PREFIXES.find((candidate) => fact.startsWith(candidate));
  return prefix ? servedFact(fact.slice(prefix.length)) : fact;
}

/** The rule for `fact`, or undefined for a fact the table does not name: an unknown fact blocks (I3, I5). */
export function factRule(fact: string): FactRule | undefined {
  const served = servedFact(fact);
  const separator = served.indexOf(":");
  const family = separator > 0 ? `${served.slice(0, separator)}:*` : undefined;
  return ownRule(served) ?? (family ? ownRule(family) : undefined);
}

// Own keys only, so a fact named like an Object.prototype member never resolves.
function ownRule(key: string): FactRule | undefined {
  return Object.hasOwn(FACT_PIN_CLASS, key) ? FACT_PIN_CLASS[key] : undefined;
}
