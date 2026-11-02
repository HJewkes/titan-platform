import { hasSlicesBlock, readSlices } from "../dispatch/report.js";
import type { TaskSlicing } from "./ports.js";
import { listedSlices, movedSlices } from "./slice-list.js";

const EPIC_TAG = "epic";
export const ALL_SLICES_LANDED = "it is sliced, and every slice is noted landed";

/** Tags a task carries when its work lands in several PRs without a plan's slices block (TP-4698). */
export const SLICE_TAGS = ["slices", "multi-slice"];

/**
 * Why one unsliced PR cannot close its task, or undefined when nothing else is due to land on it. A tagged task with no
 * slices block counts the slices its plan headings or notes list (TP-4712); a task that lists none, or whose landed slices fall outside the list, holds on the tag.
 * A last-slice PR (`register --last-slice`) skips that tag check and its derived list: an epic tag or an unlanded slice of a
 * plan's block still holds (TP-4703).
 */
export function heldOpenBy({ tags, notes, plan }: TaskSlicing, lastSlice = false): string | undefined {
  if (plan !== undefined && hasSlicesBlock(plan)) {
    const slices = readSlices(plan).slices;
    if (slices === undefined) return "its plan has a burndown-slices block that does not read";
    return heldBySlices(slices.map((slice) => slice.n), tags, notes);
  }
  const sliceTag = lastSlice ? undefined : SLICE_TAGS.find((tag) => tags.includes(tag));
  if (sliceTag === undefined) return tags.includes(EPIC_TAG) ? `it is tagged ${EPIC_TAG}` : undefined;
  const listed = listedSlices(plan, notes);
  const covers = listed.length > 0 && [...landedSlices(notes)].every((n) => listed.includes(n));
  return covers ? heldBySlices(listed, tags, notes) : `it is tagged ${sliceTag}`;
}

const landedSlices = (notes: string): Set<string> => new Set(notes.split("\n").flatMap((line) => /^(\S+) landed in /.exec(line)?.[1] ?? []));

function heldBySlices(slices: string[], tags: readonly string[], notes: string): string {
  const landed = landedSlices(notes);
  const moved = movedSlices(notes);
  const unlanded = slices.filter((n) => !landed.has(n) && !moved.has(n));
  if (unlanded.length > 0) return `it has slices ${unlanded.join(", ")}`;
  return tags.includes(EPIC_TAG) ? `it is tagged ${EPIC_TAG}` : ALL_SLICES_LANDED;
}
