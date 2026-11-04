/**
 * The D21 facts the owner reads at their own head (TP-4141): a repo skill diff (CC-1120), a CI policy the reviewer judged
 * weakened or wrote malformed, and changed files nobody read, which could hide either. Any one can hold under a gate whose
 * policy rule names something else (an owner-gate seat, an escalation route, a visual-path row), so land writes each fact
 * that holds into the gate's prompt as a marker line, and the remote merge paths read the marker, not the rule.
 */
export const OWNER_AT_HEAD_ROWS = ["skill-path", "ci-policy-weakened", "ci-policy-malformed", "files-unread"] as const;
export type OwnerAtHeadRow = (typeof OWNER_AT_HEAD_ROWS)[number];

const KNOWN: ReadonlySet<string> = new Set(OWNER_AT_HEAD_ROWS);
export const isOwnerAtHeadRow = (row: string): row is OwnerAtHeadRow => KNOWN.has(row);

/**
 * How the marker line starts. Land's first line is its own template, so the marker always sits on a later line. Land writes
 * one on every prompt that runs past its first line, naming `none` when no fact holds, so a multi-line prompt with no marker
 * is a gate opened before markers existed.
 */
export const OWNER_AT_HEAD_LEAD = "The owner reads this at their own head: ";
const NONE = "none";

/** Undefined when no marker is needed: no fact holds and the prompt is one line. */
export function ownerAtHeadNote(rows: readonly OwnerAtHeadRow[], multiLine: boolean): string | undefined {
  if (rows.length === 0 && !multiLine) return undefined;
  return `${OWNER_AT_HEAD_LEAD}${rows.length > 0 ? rows.join(", ") : NONE}.`;
}

/** Every name a prompt's marker lines carry, unknown ones and `none` included; undefined when it has no marker. */
export function ownerAtHeadNamesIn(prompt: string): string[] | undefined {
  const marked = prompt.split("\n").slice(1).filter((line) => line.startsWith(OWNER_AT_HEAD_LEAD));
  if (marked.length === 0) return undefined;
  return marked.flatMap((line) => line.slice(OWNER_AT_HEAD_LEAD.length).replace(/\.$/, "").split(", "));
}

/**
 * The rows a prompt's marker lines name; undefined when it has none. A marker naming neither `none` nor a known row reads
 * as `owner-at-head`, so a mangled marker fails closed, and text posing as a marker can only make a gate stricter.
 */
export function ownerAtHeadRowsIn(prompt: string): string[] | undefined {
  const named = ownerAtHeadNamesIn(prompt);
  if (named === undefined) return undefined;
  const rows = named.filter(isOwnerAtHeadRow);
  return rows.length > 0 || named.every((row) => row === NONE) ? rows : ["owner-at-head"];
}
