export interface CharSpan {
  start: number;
  end: number;
}

const FILLER = /\b(?:um+|uh+|you know)\b,?[ \t]*/gi;
const WORD = /[\p{L}\p{N}']+/gu;
const MAX_PHRASE_WORDS = 4;
const SHINGLE_SIZE = 3;

export function findFillers(text: string): CharSpan[] {
  return [...text.matchAll(FILLER)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

interface Word {
  key: string;
  start: number;
  end: number;
}

function words(text: string, from = 0, to = text.length): Word[] {
  return [...text.slice(from, to).matchAll(WORD)].map((m) => ({
    key: m[0].toLowerCase(),
    start: from + m.index,
    end: from + m.index + m[0].length,
  }));
}

function repeatsAt(list: readonly Word[], i: number, n: number): boolean {
  if (i + 2 * n > list.length) return false;
  for (let k = 0; k < n; k++) if (list[i + k]!.key !== list[i + n + k]!.key) return false;
  return true;
}

/** Each span is the second copy of an immediately repeated word or phrase, with its leading gap. */
export function findRepeats(text: string): CharSpan[] {
  const list = words(text);
  const spans: CharSpan[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let n = MAX_PHRASE_WORDS; n >= 1; n--) {
      if (!repeatsAt(list, i, n)) continue;
      spans.push({ start: list[i + n - 1]!.end, end: list[i + 2 * n - 1]!.end });
      i += n - 1;
      break;
    }
  }
  return spans;
}

function paragraphs(text: string): CharSpan[] {
  const spans: CharSpan[] = [];
  let from = 0;
  for (const gap of text.matchAll(/\n{2,}/g)) {
    spans.push({ start: from, end: gap.index });
    from = gap.index + gap[0].length;
  }
  spans.push({ start: from, end: text.length });
  return spans.filter((s) => text.slice(s.start, s.end).trim() !== "");
}

function shingles(list: readonly Word[]): Set<string> {
  const size = Math.min(SHINGLE_SIZE, list.length);
  const set = new Set<string>();
  for (let i = 0; i + size <= list.length; i++) {
    set.add(
      list
        .slice(i, i + size)
        .map((w) => w.key)
        .join(" "),
    );
  }
  return set;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function findNearDuplicates(text: string, threshold: number): CharSpan[] {
  const earlier: Set<string>[] = [];
  const duplicates: CharSpan[] = [];
  for (const para of paragraphs(text)) {
    const set = shingles(words(text, para.start, para.end));
    if (earlier.some((prior) => jaccard(prior, set) >= threshold)) duplicates.push(para);
    else earlier.push(set);
  }
  return duplicates;
}
