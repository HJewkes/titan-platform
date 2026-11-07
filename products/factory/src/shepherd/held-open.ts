import { hasSlicesBlock, readSlices } from "../dispatch/report.js";
import type { TaskSlicing } from "./ports.js";
import { listedSlices, movedSlices } from "./slice-list.js";

const EPIC_TAG = "epic";
/** A `hold:<reason>` tag keeps a task open past any landing, `--last-slice` included: it records work no slice list carries (TP-4714). */
const HOLD_TAG_PREFIX = "hold:";
export const ALL_SLICES_LANDED = "it is sliced, and every slice is noted landed";
export const LANDED_BEFORE_THIS_PR = "every slice had landed before this PR, so only --last-slice closes it";

/** Tags a task carries when its work lands in several PRs without a plan's slices block (TP-4698). */
export const SLICE_TAGS = ["slices", "multi-slice"];

/**
 * Why one unsliced PR cannot close its task, or undefined when nothing else is due to land on it. A tagged task with no
 * slices block counts the slices its plan headings or notes list (TP-4712); a task that lists none, or whose landed slices fall outside the list, holds on the tag.
 * A last-slice PR (`register --last-slice`) skips that tag check and its derived list: an epic tag, a hold tag or an unlanded
 * slice of a plan's block still holds (TP-4703).
 */
export function heldOpenBy(slicing: TaskSlicing, lastSlice = false, carried: readonly string[] = []): string | undefined {
  const hold = holdOf(slicing, lastSlice);
  if (hold === undefined || "reason" in hold) return hold?.reason;
  return heldBySlices(hold.slices, slicing.tags, slicing.notes, carried);
}

/** The slices a list-holding task still waits on, or none when something other than its slice list holds it. */
export function unlandedSlices(slicing: TaskSlicing, lastSlice = false): string[] {
  const hold = holdOf(slicing, lastSlice);
  if (hold === undefined || "reason" in hold) return [];
  return unlandedOf(hold.slices, slicing.notes, []);
}

type Hold = { reason: string } | { slices: string[] } | undefined;

function holdOf({ tags, notes, plan }: TaskSlicing, lastSlice: boolean): Hold {
  const hold = tags.find((tag) => tag.startsWith(HOLD_TAG_PREFIX));
  if (hold !== undefined) return { reason: `it is tagged ${hold}` };
  if (plan !== undefined && hasSlicesBlock(plan)) {
    const slices = readSlices(plan).slices;
    if (slices === undefined) return { reason: "its plan has a burndown-slices block that does not read" };
    return { slices: slices.map((slice) => slice.n) };
  }
  const sliceTag = lastSlice ? undefined : SLICE_TAGS.find((tag) => tags.includes(tag));
  if (sliceTag === undefined) return tags.includes(EPIC_TAG) ? { reason: `it is tagged ${EPIC_TAG}` } : undefined;
  const listed = listedSlices(plan, notes);
  const covers = listed.length > 0 && [...landedSlices(notes)].every((n) => listed.includes(n));
  return covers ? { slices: listed } : { reason: `it is tagged ${sliceTag}` };
}

/**
 * True when the list was already complete without this landing, so the landing cannot be what finishes the task: a slice
 * list says nothing of a task's other done_when clauses, and a task left open past its last slice has a reason (TP-4714).
 * Only this landing's own line is set aside, so a replay after a crash between the note and the close still closes.
 */
export function completedBefore(slicing: TaskSlicing, landingLine: string): boolean {
  const notes = slicing.notes.split("\n").filter((line) => line !== landingLine).join("\n");
  return heldOpenBy({ ...slicing, notes }) === ALL_SLICES_LANDED;
}

const landedSlices = (notes: string): Set<string> => new Set(notes.split("\n").flatMap((line) => /^(\S+) landed in /.exec(line)?.[1] ?? []));

const unlandedOf = (slices: string[], notes: string, carried: readonly string[]): string[] => {
  const landed = landedSlices(notes);
  const moved = movedSlices(notes);
  return slices.filter((n) => !landed.has(n) && !moved.has(n) && !carried.includes(n));
};

function heldBySlices(slices: string[], tags: readonly string[], notes: string, carried: readonly string[]): string {
  const unlanded = unlandedOf(slices, notes, carried);
  if (unlanded.length > 0) return `it has slices ${unlanded.join(", ")}`;
  return tags.includes(EPIC_TAG) ? `it is tagged ${EPIC_TAG}` : ALL_SLICES_LANDED;
}
