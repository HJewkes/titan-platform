import type { DiffPin, MergeUpProof } from "@titan-design/github";

type Cause = "rebase-context" | "conflict-merge-up" | "whitespace" | "ambiguous-base" | "unprobed" | "unclassified";

export interface PinProbe {
  readonly reviewed: DiffPin;
  readonly current: DiffPin;
  readonly mergeUp: MergeUpProof;
  readonly headIsMerge: boolean;
  /** Whether `core` is equal once whitespace is ignored; the probe runs git, this module does not. */
  readonly wsBlindCoreEqual: boolean;
}

type PinCause = { readonly class: "carry-agrees"; readonly exclusion2: boolean } | { readonly class: "pin-differs"; readonly cause: Cause };

const differs = (cause: Cause): PinCause => ({ class: "pin-differs", cause });

// Order matters: an ambiguous pin has no hashes to compare, and `full` equality is the identity.
export function pinCause(probe: PinProbe | undefined): PinCause {
  if (probe === undefined) return differs("unprobed");
  const { reviewed, current } = probe;
  if (reviewed.kind === "ambiguous" || current.kind === "ambiguous") return differs("ambiguous-base");
  if (reviewed.full === current.full) return { class: "carry-agrees", exclusion2: false };
  if (reviewed.core === current.core) return coreEqual(probe);
  return probe.wsBlindCoreEqual ? differs("whitespace") : differs("unclassified");
}

function coreEqual(probe: PinProbe): PinCause {
  if (probe.mergeUp.ok) return { class: "carry-agrees", exclusion2: true };
  return probe.headIsMerge ? differs("conflict-merge-up") : differs("rebase-context");
}
