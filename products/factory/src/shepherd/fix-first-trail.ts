import { BLOCK_LINE, DEFECT_CLASS_HEADING } from "@titan-design/review-panel";
import { z } from "zod";

/** One FIX_FIRST of the run: the head it was given at, its findings, and the reviewer's defect-class section if it wrote one. */
export interface FixFirstEntry {
  headSha: string;
  text: string;
  defectClass?: string;
}

export const FixFirstEntrySchema = z.looseObject({ headSha: z.string(), text: z.string(), defectClass: z.string().optional() });

const isDefectHeading = (line: string): boolean => line.replace(/^[\s#*]+/, "").toLowerCase().startsWith(DEFECT_CLASS_HEADING.toLowerCase());

/** The reviewer's newest defect-class section, from its heading to the verdict block; undefined when the reviewer wrote none. */
export function defectClassSection(text: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.length - 1 - [...lines].reverse().findIndex(isDefectHeading);
  if (start >= lines.length) return undefined;
  const end = lines.findIndex((line, index) => index > start && BLOCK_LINE.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}

const HEADING_WORDS = /^defect class\s*/;

/** The named class, so two reviewers' spellings of it compare equal whatever their case, punctuation or spacing; undefined when none is named. */
export function defectClassKey(text: string): string | undefined {
  const firstLine = defectClassSection(text)?.split("\n")[0];
  if (firstLine === undefined) return undefined;
  const key = firstLine.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().replace(HEADING_WORDS, "");
  return key === "" ? undefined : key;
}

const keyOf = (entry: FixFirstEntry): string | undefined => defectClassKey(entry.defectClass ?? entry.text);

/** True when the current FIX_FIRST names a class some earlier round of the run already named. */
export function sameClassAsEarlier(earlier: readonly FixFirstEntry[], current: FixFirstEntry): boolean {
  const key = keyOf(current);
  return key !== undefined && earlier.some((entry) => keyOf(entry) === key);
}

/** A FIX_FIRST's entry for the run's trail, its class read once from the findings. */
export function fixFirstEntry(headSha: string, text: string): FixFirstEntry {
  const defectClass = defectClassSection(text);
  return defectClass === undefined ? { headSha, text } : { headSha, text, defectClass };
}
