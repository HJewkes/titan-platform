const LABEL = String.raw`(?:S?\d+[a-z]?|[a-z](?:\d+[a-z]?)?)`;
const ITEM = `${LABEL}(?:-${LABEL})?`;
const SEPARATOR = String.raw`(?:\s*(?:,|->|&)\s*(?:and\s+)?|\s+(?:and|then)\s+)`;
const LIST = `${ITEM}(?:${SEPARATOR}${ITEM})*`;

const SLICE_HEADING = /^#{2,4}\s+(?:(?:[Ss]lice\s+([a-z0-9]+)\b)|(S\d+[a-z]?)\b|([a-z]\d*[a-z]?)(?=[:.]|\s+[(—–-]|\s*$))/gm;
const ARROW_ORDER = new RegExp(String.raw`\b[Oo]rder[: ]+(${LIST})(?![\w-])`, "g");
const PROSE_LIST = /\b[Ss]lices (S\d+[a-z]?\b.*?)(?:\.(?:\s|$)|$)/gm;
const PROSE_LABEL = /\bS\d+[a-z]?\b/g;
const MOVED = new RegExp(String.raw`\b(${LIST}) (?:was |were |is |are )?(?:moved|left|handed|reassigned) to (?:[\w-]+/)?[A-Z][A-Z0-9]*-\d+`, "g");
const SHEPHERD_HOLD_LINE = /task left open:/;

/** The slices a plan without a burndown-slices block lists: its slice headings, or failing those the task's notes. One heading is a section about a slice, not a list. */
export function listedSlices(plan: string | undefined, notes: string): string[] {
  const headed = unique(plan === undefined ? [] : [...plan.matchAll(SLICE_HEADING)].flatMap((match) => match[1] ?? match[2] ?? match[3] ?? []));
  return headed.length > 1 ? headed : notedSlices(notes);
}

/** Slices the notes hand to another task; that task owns them, so they cannot hold this one open. */
export function movedSlices(notes: string): Set<string> {
  return new Set([...notes.matchAll(MOVED)].flatMap((match) => labelsOf(match[1]!)));
}

/**
 * Only a full declaration counts: an arrow order or a described `Slices S1 x, S2 y.` sentence. Scored against real slices
 * blocks, comma lists and ranges in notes ("Slices a and c", "slices e-h") were mostly partial, and a partial list closes early.
 */
function notedSlices(notes: string): string[] {
  const declared = notes.split("\n").filter((line) => !SHEPHERD_HOLD_LINE.test(line)).join("\n");
  const ordered = [...declared.matchAll(ARROW_ORDER)].filter((match) => match[1]!.includes("->")).map((match) => labelsOf(match[1]!));
  const prose = [...declared.matchAll(PROSE_LIST)].map((match) => match[1]!.match(PROSE_LABEL) ?? []).filter((labels) => labels.length > 1);
  return unique([...ordered, ...prose].flat());
}

function labelsOf(list: string): string[] {
  return list.split(new RegExp(SEPARATOR)).flatMap((item) => {
    const [from, to] = item.split("-");
    return to === undefined ? [from!] : rangeOf(from!, to);
  });
}

function rangeOf(from: string, to: string): string[] {
  const [first, last] = [/^(S?)(\d+)$/.exec(from), /^(S?)(\d+)$/.exec(to)];
  if (first && last && first[1] === last[1] && Number(first[2]) < Number(last[2])) {
    return spread(Number(first[2]), Number(last[2])).map((n) => `${first[1]}${n}`);
  }
  if (/^[a-z]$/.test(from) && /^[a-z]$/.test(to) && from < to) {
    return spread(from.charCodeAt(0), to.charCodeAt(0)).map((code) => String.fromCharCode(code));
  }
  return [from, to];
}

const spread = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const unique = (labels: string[]): string[] => [...new Set(labels)];
