/** A label younger than this stays `pending`: a revert or a fix can still land on top of the merge. */
export const LABEL_MATURITY_DAYS = 14;
export const LABEL_MATURITY_MS = LABEL_MATURITY_DAYS * 24 * 60 * 60 * 1000;

/** Null where the evidence is missing (no clone, the head is not in it, the PR never merged), so absence is never read as a clean result. */
export interface RawLabels {
  revert: boolean | null;
  "main-red": boolean | null;
  "later-fix": boolean | null;
  "owner-override": boolean;
  "fixer-changed-cited-paths": boolean | null;
}

/**
 * `unresolved` is a mature head whose outcome the evidence cannot decide: a MERGE whose PR never merged, or a FIX_FIRST
 * with no later head or no path it cited.
 */
export type CorpusLabel = "escaped" | "caught" | "false-block" | "clean" | "pending" | "unresolved";

export interface LabelInput {
  verdict: "MERGE" | "FIX_FIRST";
  verdictAt: string;
  now: Date;
  merged: boolean;
  labels: RawLabels;
  /** The owner's recorded reason for an override; an override without one is not yet a label. */
  overrideReason: string | null;
}

const isMature = (input: LabelInput): boolean => input.now.getTime() - Date.parse(input.verdictAt) >= LABEL_MATURITY_MS;

function mergeLabel({ merged, labels }: LabelInput): CorpusLabel {
  if (!merged) return "unresolved";
  const outcomes = [labels.revert, labels["main-red"], labels["later-fix"]];
  if (outcomes.includes(true)) return "escaped";
  return outcomes.includes(null) ? "unresolved" : "clean";
}

function fixFirstLabel({ labels }: LabelInput): CorpusLabel {
  const changed = labels["fixer-changed-cited-paths"];
  if (changed === null) return "unresolved";
  return changed ? "caught" : "false-block";
}

/** An owner override outranks the git evidence: a block merged over is a false block, a merge the owner stopped escaped review. */
export function deriveLabel(input: LabelInput): CorpusLabel {
  if (!isMature(input)) return "pending";
  if (input.labels["owner-override"]) {
    if (input.overrideReason === null || input.overrideReason.trim() === "") return "pending";
    return input.verdict === "MERGE" ? "escaped" : "false-block";
  }
  return input.verdict === "MERGE" ? mergeLabel(input) : fixFirstLabel(input);
}
