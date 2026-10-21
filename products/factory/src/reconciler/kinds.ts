/** The snapshot and ruleset reads observe turns into rows. */
type ReconcilerRead = "main" | "open" | "done" | "rulesets";

interface ReconcilerKind {
  read: ReconcilerRead;
  kinds: readonly string[];
}

/**
 * Declared, so TP-3099's kind-set diff reads what the reconciler can write: a polling deployment has no other GitHub source,
 * so a kind missing here is a kind it never logs. Observe drops any kind its read does not list.
 */
export const RECONCILER_KINDS: readonly ReconcilerKind[] = [
  { read: "main", kinds: ["MainMoved", "CIConcluded"] },
  { read: "open", kinds: ["HeadPushed", "BaseChanged", "ReviewSubmitted", "ReviewDismissed", "CIConcluded"] },
  { read: "done", kinds: ["PRMerged", "PRClosed"] },
  { read: "rulesets", kinds: ["RulesChanged"] },
];

export function declaredFor(read: ReconcilerRead): <E extends { kind: string }>(event: E) => boolean {
  const kinds = new Set(RECONCILER_KINDS.filter((row) => row.read === read).flatMap((row) => row.kinds));
  return (event) => kinds.has(event.kind);
}
