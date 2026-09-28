/**
 * Which task a spawned session was assigned, read from its agent name and spawn brief (TP-407).
 * The rules are the normative "Linking rules" of the TP-407 plan; TP-108 shares `orientationEnd`.
 */

import { TASK_ID } from "./bash-parse.js";

/** agent-chat opens an injected orientation block with this line. */
export const ORIENTATION_HEADER = '# Orientation: active-work initiative "';

/** `none` is a definite "no id links", distinct from a session no task-aware resolver has seen. */
export type AssignmentSource = "name" | "name-over-brief" | "brief-anchor" | "brief-paragraph" | "none";

export interface AssignmentInput {
  readonly agentName: string;
  readonly brief: string;
  /** True when the id is a task file in the active-work store, archived or not. */
  readonly isKnown: (taskId: string) => boolean;
}

export interface Assignment {
  readonly taskIds: readonly string[];
  readonly source: AssignmentSource;
}

/** agent-chat caps an orientation at 9,000 characters plus its truncation marker. */
const ORIENTATION_WINDOW = 9_015;
const ANCHOR_WINDOW = 2_000;
const PARAGRAPH_WINDOW = 1_500;
const MAX_ASSIGNED = 3;

const ORIENTATION_HEADINGS = ["## Brief (brief.md)", "## Open tasks", "## Most recent session", "## Related to this assignment"];
const RELATED_HEADING = "## Related to this assignment";
const TRUNCATION_MARKER = "\n… (truncated)";
const EARLIER_SESSIONS = "Earlier sessions on disk:";
const ANCHOR = /^[#*_>\s]*(?:your task|task|assignment|implement|goal)\b/i;
const TASK_IDS = new RegExp(TASK_ID.source, "g");
const NAME_IDS = /(?<![a-z0-9])(?:([a-z]{2,5})-?|([a-z])-)(\d+)(?![a-z0-9])/g;
const WORD_CHAR = /[A-Za-z0-9-]/;
const NONE: Assignment = { taskIds: [], source: "none" };

interface Line {
  readonly start: number;
  readonly end: number;
}

/** Lines of `text` that start at or after `from` and before `limit`. */
function* linesOf(text: string, from: number, limit: number): Generator<Line> {
  let start = from;
  while (start < limit && start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    yield { start, end };
    if (newline === -1) return;
    start = newline + 1;
  }
}

function lineText(text: string, line: Line): string {
  const raw = text.slice(line.start, line.end);
  return raw.endsWith("\r") ? raw.slice(0, -1) : raw;
}

function nextLineStart(text: string, position: number): number {
  const newline = text.indexOf("\n", position);
  return newline === -1 ? text.length : newline + 1;
}

/** `text[from, from + length)`, dropping a trailing id or word the bound cuts in two. */
function windowOf(text: string, from: number, length: number): string {
  const to = Math.min(text.length, from + length);
  let end = to;
  if (WORD_CHAR.test(text.charAt(to))) {
    while (end > from && WORD_CHAR.test(text.charAt(end - 1))) end--;
  }
  return text.slice(from, end);
}

function isOrientationHeading(text: string): boolean {
  return ORIENTATION_HEADINGS.some((heading) => text.startsWith(heading));
}

/** The last orientation heading in the window, or the header line when there is none. */
function lastHeading(brief: string, headerStart: number): Line {
  let last: Line = { start: headerStart, end: nextLineStart(brief, headerStart) - 1 };
  for (const line of linesOf(brief, headerStart, ORIENTATION_WINDOW)) {
    if (isOrientationHeading(brief.slice(line.start, line.start + RELATED_HEADING.length))) last = line;
  }
  return last;
}

/** Rule 1: the first line after the related list that is neither blank nor a `- ` item. */
function afterRelatedList(brief: string, heading: Line): number | null {
  for (const line of linesOf(brief, heading.end + 1, brief.length)) {
    if (line.start >= ORIENTATION_WINDOW) return line.start;
    const text = lineText(brief, line);
    if (text.trim() !== "" && !text.startsWith("- ")) return line.start;
  }
  return null;
}

/** Rule 2: after the last truncation marker, skipping blank lines and one `Earlier sessions` line. */
function afterTruncation(brief: string, heading: Line): number | null {
  const marker = brief.slice(0, ORIENTATION_WINDOW).lastIndexOf(TRUNCATION_MARKER);
  if (marker < heading.end) return null;
  let position = nextLineStart(brief, marker + TRUNCATION_MARKER.length);
  for (const line of linesOf(brief, position, brief.length)) {
    if (lineText(brief, line).trim() !== "") break;
    position = nextLineStart(brief, line.end);
  }
  return brief.startsWith(EARLIER_SESSIONS, position) ? nextLineStart(brief, position) : position;
}

/** Rule 3: the first anchor line after the last heading. */
function firstAnchorAfter(brief: string, heading: Line): number | null {
  for (const line of linesOf(brief, heading.end + 1, ORIENTATION_WINDOW)) {
    if (ANCHOR.test(brief.slice(line.start, line.start + 64))) return line.start;
  }
  return null;
}

/**
 * Where the assignment starts in a spawn brief: 0 when the brief has no orientation block,
 * null when it has one whose end cannot be found (such a brief yields no ids).
 */
export function orientationEnd(brief: string): number | null {
  const head = brief.slice(0, ORIENTATION_WINDOW);
  const headerStart = head.length - head.trimStart().length;
  if (!brief.startsWith(ORIENTATION_HEADER, headerStart)) return 0;
  const heading = lastHeading(brief, headerStart);
  const headingText = brief.slice(heading.start, heading.start + RELATED_HEADING.length);
  if (headingText === RELATED_HEADING) return afterRelatedList(brief, heading);
  return afterTruncation(brief, heading) ?? firstAnchorAfter(brief, heading);
}

function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Ids from the agent name; more than three distinct known ids is a list and yields none. */
function nameTaskIds(agentName: string, isKnown: AssignmentInput["isKnown"]): string[] {
  const ids: string[] = [];
  for (const match of agentName.toLowerCase().matchAll(NAME_IDS)) {
    const id = `${(match[1] ?? match[2] ?? "").toUpperCase()}-${match[3] ?? ""}`;
    if (isKnown(id)) ids.push(id);
  }
  const known = distinct(ids);
  return known.length > MAX_ASSIGNED ? [] : known;
}

interface AnchorLine extends Line {
  readonly text: string;
}

function findAnchor(brief: string, regionStart: number): AnchorLine | null {
  const window = windowOf(brief, regionStart, ANCHOR_WINDOW);
  for (const line of linesOf(window, 0, window.length)) {
    const text = lineText(window, line);
    if (ANCHOR.test(text)) return { start: regionStart + line.start, end: regionStart + line.end, text };
  }
  return null;
}

function parenthesisDepth(depth: number, char: string): number {
  if (char === "(") return depth + 1;
  if (char === ")") return Math.max(0, depth - 1);
  return depth;
}

/** Known ids outside parentheses, or the parenthesised ones when no id at all sits outside. */
function anchorTaskIds(line: string, isKnown: AssignmentInput["isKnown"]): string[] {
  const outside: string[] = [];
  const inside: string[] = [];
  let anyOutside = false;
  let depth = 0;
  let cursor = 0;
  for (const match of line.matchAll(TASK_IDS)) {
    for (; cursor < match.index; cursor++) depth = parenthesisDepth(depth, line.charAt(cursor));
    const id = match[1] ?? "";
    anyOutside ||= depth === 0;
    if (isKnown(id)) (depth === 0 ? outside : inside).push(id);
  }
  if (distinct([...outside, ...inside]).length > MAX_ASSIGNED) return [];
  return distinct(anyOutside ? outside : inside);
}

/** The first known id in the region's opening paragraph window, never one on the anchor line. */
function paragraphTaskId(brief: string, regionStart: number, anchor: Line | null, isKnown: AssignmentInput["isKnown"]): string | null {
  const window = windowOf(brief, regionStart, PARAGRAPH_WINDOW);
  for (const match of window.matchAll(TASK_IDS)) {
    const at = regionStart + match.index;
    if (anchor && at >= anchor.start && at < anchor.end) continue;
    const id = match[1] ?? "";
    if (isKnown(id)) return id;
  }
  return null;
}

function briefTaskIds(brief: string, isKnown: AssignmentInput["isKnown"]): Assignment {
  const regionStart = orientationEnd(brief);
  if (regionStart === null) return NONE;
  const anchor = findAnchor(brief, regionStart);
  const anchored = anchor ? anchorTaskIds(anchor.text, isKnown) : [];
  if (anchored.length > 0) return { taskIds: anchored, source: "brief-anchor" };
  const paragraph = paragraphTaskId(brief, regionStart, anchor, isKnown);
  return paragraph ? { taskIds: [paragraph], source: "brief-paragraph" } : NONE;
}

/** The task ids a spawned session was assigned, and which rule found them. */
export function assignedTaskIds({ agentName, brief, isKnown }: AssignmentInput): Assignment {
  const named = nameTaskIds(agentName, isKnown);
  const fromBrief = briefTaskIds(brief, isKnown);
  if (named.length === 0) return fromBrief;
  const agrees = fromBrief.taskIds.length === 0 || fromBrief.taskIds.some((id) => named.includes(id));
  return { taskIds: named, source: agrees ? "name" : "name-over-brief" };
}
