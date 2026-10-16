import { escapeRegExp } from "./regexp.js";

const LINK = /\[([^\]]+)\]\(([^)]*)\)/g;

/** The text the voice is given: `[w](/phonemes/)` overrides stay for misaki, `[w](=reading)` declarations become the bare word. */
export function g2pText(spoken: string): string {
  return spoken.replace(LINK, (link, word: string, target: string) => (target.startsWith("/") ? link : word));
}

/** The text captions and word counts use, with all markup removed. */
export function plainText(spoken: string): string {
  return spoken.replace(LINK, (_link, word: string) => word);
}

export interface MarkupSegment {
  kind: "plain" | "link";
  text: string;
}

/** The line as alternating plain and `[w](target)` link segments; joining their text gives back the input. */
export function splitLinks(spoken: string): MarkupSegment[] {
  const segments: MarkupSegment[] = [];
  let last = 0;
  for (const match of spoken.matchAll(LINK)) {
    if (match.index > last) segments.push({ kind: "plain", text: spoken.slice(last, match.index) });
    segments.push({ kind: "link", text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < spoken.length) segments.push({ kind: "plain", text: spoken.slice(last) });
  return segments;
}

/** How many times `form` occurs in `text` as a whole word, case-insensitively. */
export function countOccurrences(text: string, form: string): number {
  return text.match(new RegExp(`(?<![A-Za-z'])${escapeRegExp(form)}(?![A-Za-z'])`, "gi"))?.length ?? 0;
}

/** Key of one occurrence of a form: the lowercased form and its zero-based ordinal among that form's occurrences. */
export function occurrenceKey(form: string, ordinal: number): string {
  return `${form}#${ordinal}`;
}

/** The target of each `[word](target)` link in the line, keyed by {@link occurrenceKey} of its word in the plain text. */
export function markupTargets(spoken: string): Map<string, string> {
  const targets = new Map<string, string>();
  let plain = "";
  let last = 0;
  for (const match of spoken.matchAll(LINK)) {
    const [link, word = "", target = ""] = match;
    plain += plainText(spoken.slice(last, match.index));
    const form = word.toLowerCase();
    targets.set(occurrenceKey(form, countOccurrences(plain, form)), target);
    plain += word;
    last = match.index + link.length;
  }
  return targets;
}
