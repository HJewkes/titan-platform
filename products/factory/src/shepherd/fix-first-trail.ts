import { BLOCK_LINE, DEFECT_CLASS_HEADING, type EarlierFinding } from "@titan-design/review-panel";
import { z } from "zod";

/** One FIX_FIRST of the run: the head it was given at, its findings, and the reviewer's defect-class section if it wrote one. */
export interface FixFirstEntry {
  headSha: string;
  text: string;
  defectClass?: string;
}

/** A run's FIX_FIRSTs, oldest first; `countRound` builds it as verdicts replay, so a restart rebuilds it without a step of its own. */
export interface FixFirstTrail {
  fixFirstTrail: FixFirstEntry[];
  /** The head D8's one convergence review went to (TP-3734); a moved head re-arms it. */
  convergedAt?: string;
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

/** The verdict plus the trail before it, which `countRound` has just appended at this head; a first FIX_FIRST's payload is the verdict alone, as before the trail. */
export function withEarlier<T extends object>(verdict: T, trail: readonly FixFirstEntry[], headSha: string): T & { earlier?: FixFirstEntry[] } {
  const earlier = trail.at(-1)?.headSha === headSha ? trail.slice(0, -1) : [...trail];
  return earlier.length === 0 ? verdict : { ...verdict, earlier };
}

const SUMMARY_CLASS_CHARS = 120;

/** One line per FIX_FIRST, oldest first: its head and the class its reviewer named, so a seat notice stays short. */
export function trailSummary(trail: readonly FixFirstEntry[]): string[] {
  return trail.map((entry, index) => {
    const named = entry.defectClass?.split("\n")[0]?.replace(/^[\s#*]+/, "").trim();
    const cls = named ? named.slice(0, SUMMARY_CLASS_CHARS) : "no defect class named";
    return `FIX_FIRST ${index + 1} at ${entry.headSha.slice(0, 12)}: ${cls}`;
  });
}

/** D8's convergence review at `headSha` carries the run's whole trail; any other review carries none. */
export function convergenceOf(run: FixFirstTrail, headSha: string): { convergence?: FixFirstEntry[] } {
  return run.convergedAt === headSha ? { convergence: [...run.fixFirstTrail] } : {};
}

/** The reviewer brief's convergence fields for a trail; only the correctness reviewer gets them, and panel members review as usual. */
export function convergenceFields(trail: readonly FixFirstEntry[] | undefined): { convergence?: true; earlierFindings?: EarlierFinding[] } {
  if (trail === undefined) return {};
  return { convergence: true, earlierFindings: trail.map((entry) => ({ head: entry.headSha, text: entry.text, ...(entry.defectClass !== undefined && { defectClass: entry.defectClass }) })) };
}
