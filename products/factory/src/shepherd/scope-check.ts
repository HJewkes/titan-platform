import { BLOCK_LINE, CLASS_TAG, DEFECT_CLASS_HEADING, EARLIER_FINDINGS_HEADING, FOLLOW_UPS_HEADING, IMPORTANT_TAG } from "@titan-design/review-panel";

/** A fix's changed lines at the head, `start` to `end` inclusive; `end` below `start` is a pure deletion after line `start`. */
export interface CheckedHunk {
  path: string;
  start: number;
  end: number;
}

interface ScopeViolations {
  /** New items whose every cite is outside the fix's ranges, with no `Important:` tag and `Class:` line. */
  untagged: string[];
  /** New items that equal an earlier finding's item once case, punctuation and spacing are dropped. */
  repeated: string[];
}

/** A top-level list item: a bullet, or a number that may be bold. */
const ITEM_START = /^(?:[-*]\s+|(?:\*\*)?\d+[.)]\s*)/;
/** The citation form the panel aggregate reads, with the line kept. */
const CITE = /(?<![\w./-])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w*):(\d+)/g;
/** The checklist's rows restate earlier findings by design, so they are never new items. */
const CHECKLIST_ROW = /^(?:fixed|partly fixed|not fixed):/i;
const SECTIONS = [EARLIER_FINDINGS_HEADING, DEFECT_CLASS_HEADING, FOLLOW_UPS_HEADING].map((heading) => heading.toLowerCase());
const CLASS_LINE = new RegExp(`(?:^|[\\s*_])${CLASS_TAG}\\s*\\S`, "m");

const unmarked = (line: string): string => line.replace(/^[\s#>*_]+/, "");
const isSection = (line: string): boolean => SECTIONS.some((heading) => unmarked(line).toLowerCase().startsWith(heading));
const itemBody = (item: string): string => unmarked(item.replace(ITEM_START, ""));

interface Reading {
  items: string[][];
  current?: string[];
  /** Inside a checklist, defect-class or follow-ups section, until the blank line after its first row. */
  section?: "heading" | "rows";
  blank: boolean;
}

function readLine(reading: Reading, line: string): void {
  const blank = line.trim() === "";
  const after = reading.blank;
  reading.blank = blank;
  if (blank) return void (reading.section === "rows" && (reading.section = undefined));
  if (isSection(line)) return void Object.assign(reading, { section: "heading", current: undefined });
  if (reading.section !== undefined) return void (reading.section = "rows");
  if (ITEM_START.test(line)) return void reading.items.push((reading.current = [line]));
  if (reading.current && (!after || /^\s/.test(line))) return void reading.current.push(line);
  reading.current = undefined;
}

/** The blocking items of a FIX_FIRST: top-level list items above the verdict block, outside the sections that are not items. */
export function blockingItems(text: string): string[] {
  const reading: Reading = { items: [], blank: false };
  for (const line of text.split("\n")) {
    if (BLOCK_LINE.test(line)) break;
    readLine(reading, line);
  }
  return reading.items.map((lines) => lines.join("\n")).filter((item) => !CHECKLIST_ROW.test(itemBody(item)));
}

const samePath = (hunkPath: string, cited: string): boolean => hunkPath === cited || hunkPath.endsWith(`/${cited}`);
const covers = (hunk: CheckedHunk, line: number): boolean => (hunk.end < hunk.start ? line === hunk.start || line === hunk.start + 1 : line >= hunk.start && line <= hunk.end);
const inside = (hunks: readonly CheckedHunk[], path: string, line: number): boolean => hunks.some((hunk) => samePath(hunk.path, path) && covers(hunk, line));

/** An item with no cite cannot be placed, so only one whose every cite falls outside the ranges is out of scope. */
function outOfScope(item: string, hunks: readonly CheckedHunk[]): boolean {
  const cites = [...item.matchAll(CITE)].map((match) => ({ path: match[1] ?? "", line: Number(match[2]) }));
  return cites.length > 0 && cites.every((cite) => !inside(hunks, cite.path, cite.line));
}

const tagged = (item: string): boolean => itemBody(item).startsWith(IMPORTANT_TAG) && CLASS_LINE.test(item);

/** The same normalization `defectClassKey` gives a class, so a repeat differing only in case, punctuation or spacing matches. */
const normalized = (item: string): string => itemBody(item).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const headline = (item: string): string => item.split("\n")[0] ?? "";

/** The scoped fix round's two rules, checked on the reviewer's own items; `posted` is the open findings' text the brief carried. */
export function scopeViolations(text: string, hunks: readonly CheckedHunk[], posted: readonly string[]): ScopeViolations {
  const items = blockingItems(text);
  const earlier = new Set(posted.flatMap(blockingItems).map(normalized).filter((key) => key !== ""));
  return {
    untagged: items.filter((item) => outOfScope(item, hunks) && !tagged(item)).map(headline),
    repeated: items.filter((item) => earlier.has(normalized(item))).map(headline),
  };
}
