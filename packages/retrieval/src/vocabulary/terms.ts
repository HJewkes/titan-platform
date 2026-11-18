const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 40;
const MIN_HEX_LENGTH = 7;

const STOP_WORDS = new Set(
  (
    "the and for are but not you all can had her was one our out has his how its may new now old see way who did get " +
    "let say she too use will with this that from they been have many some them than each which their there these " +
    "would about could other into more also back when only come over such take very what just"
  ).split(" "),
);

/** Length in code points, so an astral character counts once. */
export function termLength(term: string): number {
  return Array.from(term).length;
}

function isNoise(lower: string): boolean {
  if (!/\p{L}/u.test(lower)) return true;
  // A commit sha or hash is unique to one document, so it never helps a correction.
  return lower.length >= MIN_HEX_LENGTH && /^[0-9a-f]+$/.test(lower) && /\d/.test(lower);
}

/**
 * Distinctive terms of a text, keyed by the stored (lowercase) term. Each value
 * is the first cased form seen, which is what `scoreTerm` should score: the
 * identifier bonus reads camelCase, and lowercasing first would erase it.
 */
export function extractTerms(text: string): Map<string, string> {
  const terms = new Map<string, string>();
  for (const word of text.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
    const length = termLength(word);
    if (length < MIN_TERM_LENGTH || length > MAX_TERM_LENGTH) continue;
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower) || isNoise(lower) || terms.has(lower)) continue;
    terms.set(lower, word);
  }
  return terms;
}

function isIdentifier(term: string): boolean {
  return /[_-]/.test(term) || /\p{Ll}\p{Lu}/u.test(term);
}

/** IDF plus a length bonus plus an identifier bonus. Pass the cased form so camelCase earns its bonus. */
export function scoreTerm(term: string, docFrequency: number, totalDocs: number): number {
  const idf = totalDocs > 0 ? Math.log(totalDocs / (docFrequency + 1)) + 1 : 1;
  const lengthBonus = Math.min(termLength(term) / 10, 1);
  const identifierBonus = isIdentifier(term) ? 0.5 : 0;
  return idf + lengthBonus + identifierBonus;
}
