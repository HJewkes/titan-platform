/** More words than this, or more text than the budget, reads as unknown: the caller fails closed. */
export const BRACE_EXPANSION_CAP = 256;
const TEXT_BUDGET = 1 << 22;

const SEQUENCE_RE = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/;

interface BracePair {
  open: number;
  close: number;
  /** A comma at the pair's own depth, which makes it a list rather than literal text. */
  comma: boolean;
}

/** Every matched `{…}` in one pass; a `{` right after `$` opens a parameter expansion, not a list. */
function bracePairs(text: string): BracePair[] {
  const pairs: BracePair[] = [];
  const open: Array<{ at: number; comma: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{" && text[i - 1] !== "$") open.push({ at: i, comma: false });
    else if (c === "," && open.length > 0) (open.at(-1) as { comma: boolean }).comma = true;
    else if (c === "}" && open.length > 0) {
      const top = open.pop() as { at: number; comma: boolean };
      pairs.push({ open: top.at, close: i, comma: top.comma });
    }
  }
  return pairs.sort((a, b) => a.open - b.open);
}

/** The list items at the pair's own depth; nested lists stay whole and expand on a later pass. */
function listItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    else if (body[i] === "," && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  return [...items, body.slice(start)];
}

/** Bash's `{a..b}` and `{a..b..step}` over integers (zero-padded when an end is) or single letters; null when not one. */
function sequenceItems(body: string): string[] | null {
  const m = SEQUENCE_RE.exec(body);
  if (!m) return null;
  const [, from = "", to = "", by] = m;
  const numeric = /\d/.test(from);
  if (numeric !== /\d/.test(to)) return null;
  const start = numeric ? Number(from) : from.charCodeAt(0);
  const end = numeric ? Number(to) : to.charCodeAt(0);
  const step = Math.abs(Number(by ?? 1)) || 1;
  if (Math.abs(end - start) / step >= BRACE_EXPANSION_CAP) return [];
  const width = numeric && [from, to].some((e) => /^-?0\d/.test(e)) ? Math.max(from.length, to.length) : 0;
  const items: string[] = [];
  for (let v = start; start <= end ? v <= end : v >= end; v += start <= end ? step : -step) {
    items.push(numeric ? String(v).padStart(width, "0") : String.fromCharCode(v));
  }
  return items;
}

/** No sequence body is longer; a longer comma-less pair is literal text, read without slicing it. */
const SEQUENCE_MAX = 48;

/** The first pair bash would expand, with its items; a pair with no comma and no sequence is literal text. */
function firstExpansion(text: string): { pair: BracePair; items: string[] } | null {
  for (const pair of bracePairs(text)) {
    if (!pair.comma && pair.close - pair.open > SEQUENCE_MAX) continue;
    const body = text.slice(pair.open + 1, pair.close);
    const items = pair.comma ? listItems(body) : sequenceItems(body);
    if (items !== null) return { pair, items };
  }
  return null;
}

/**
 * The words bash's brace expansion makes of `text` read as unquoted shell text, or null when they pass the cap or the
 * text budget. A sequence too long to list counts as past the cap.
 */
export function braceExpansions(text: string): string[] | null {
  const words: string[] = [];
  const pending = [text];
  let spent = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    spent += next.length;
    if (spent > TEXT_BUDGET) return null;
    const found = firstExpansion(next);
    if (found === null) words.push(next);
    else if (found.items.length === 0) return null;
    else {
      const [before, after] = [next.slice(0, found.pair.open), next.slice(found.pair.close + 1)];
      pending.push(...found.items.map((item) => before + item + after).reverse());
    }
    if (words.length + pending.length > BRACE_EXPANSION_CAP) return null;
  }
  return words;
}
