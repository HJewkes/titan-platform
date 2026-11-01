import { hasSlicesBlock, readSlices } from "../dispatch/report.js";
import type { TaskSlicing } from "./cleanup.js";

const EPIC_TAG = "epic";
export const ALL_SLICES_LANDED = "it is sliced, and every slice is noted landed";

/** Tags a task carries when its work lands in several PRs without a plan's slices block (TP-4698). */
export const SLICE_TAGS = ["slices", "multi-slice"];

/**
 * Why one unsliced PR cannot close its task, or undefined when nothing else is due to land on it. A last-slice PR
 * (`register --last-slice`) skips only the slices/multi-slice tag check: an epic tag or an unlanded plan slice still holds (TP-4703).
 */
export function heldOpenBy({ tags, notes, plan }: TaskSlicing, lastSlice = false): string | undefined {
  if (plan !== undefined && hasSlicesBlock(plan)) {
    const slices = readSlices(plan).slices;
    if (slices === undefined) return "its plan has a burndown-slices block that does not read";
    const landed = new Set(notes.split("\n").flatMap((line) => /^(\S+) landed in /.exec(line)?.[1] ?? []));
    const unlanded = slices.map((slice) => slice.n).filter((n) => !landed.has(n));
    if (unlanded.length > 0) return `it has slices ${unlanded.join(", ")}`;
    return tags.includes(EPIC_TAG) ? `it is tagged ${EPIC_TAG}` : ALL_SLICES_LANDED;
  }
  const sliceTag = lastSlice ? undefined : SLICE_TAGS.find((tag) => tags.includes(tag));
  if (sliceTag !== undefined) return `it is tagged ${sliceTag}`;
  return tags.includes(EPIC_TAG) ? `it is tagged ${EPIC_TAG}` : undefined;
}
