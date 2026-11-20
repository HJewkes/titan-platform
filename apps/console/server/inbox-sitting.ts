/**
 * A sitting (a deposit with steps) offers the tap of the step the owner is on: the first step with no recorded outcome.
 * Its op goes through the same mapping as a deposit's own op, so a step that merges a PR is the existing merge tap. A
 * sitting is kind do and carries no options, so it never auto-resolves by recommendation (TP-6765 excludes it).
 */
import type { OwnerItem, OwnerOp } from "@titan-design/owner-queue";

/** The op the item's tap acts on: its own, or for a sitting the current step's; undefined when that step has none. */
export function tapOp(item: OwnerItem): OwnerOp | undefined {
  return item.op ?? item.steps?.find((step) => step.outcome === undefined)?.op;
}
