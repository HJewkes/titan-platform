// Port of misaki 0.9.4 `MToken` (token.py) and `merge_tokens` (en.py:13-41), Apache-2.0.

/** misaki's `token._` extension fields. */
export interface Underscore {
  isHead: boolean;
  /** Text to look up in place of the token's own, as when "2" between letters reads "to". */
  alias: string | null;
  stress: number | null;
  currency: string | null;
  numFlags: string;
  prespace: boolean;
  rating: number | null;
}

/**
 * A token as misaki's pipeline mutates it. misaki keeps two ratings: `_.rating`, which `merge_tokens` reads, and
 * a plain `rating` attribute that the lexicon and fallback paths set. The reported rating is the first, else the
 * second, so a token merged from parts whose `_.rating` is unset reports `null` even when it has phonemes.
 */
export interface MToken {
  text: string;
  tag: string;
  whitespace: string;
  phonemes: string | null;
  rating: number | null;
  _: Underscore;
}

export function underscore(fields: Partial<Underscore> = {}): Underscore {
  return {
    isHead: true,
    alias: null,
    stress: null,
    currency: null,
    numFlags: "",
    prespace: false,
    rating: null,
    ...fields,
  };
}

// Python str.isspace() over one character.
const PY_SPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;
export const isPySpace = (c: string): boolean => PY_SPACE.test(c);

const byCodePoint = (a: string, b: string): number => a.codePointAt(0)! - b.codePointAt(0)!;

// Python max() keeps the first of equal keys: an uppercase character weighs 2, anything else 1.
function heaviestTag(tokens: readonly MToken[]): string {
  const weight = (tk: MToken): number => [...tk.text].reduce((n, c) => n + (c === c.toLowerCase() ? 1 : 2), 0);
  return tokens.reduce((best, tk) => (weight(tk) > weight(best) ? tk : best)).tag;
}

function joinPhonemes(tokens: readonly MToken[], unk: string): string {
  let phonemes = "";
  for (const tk of tokens) {
    if (tk._.prespace && phonemes && !isPySpace(phonemes.at(-1)!) && tk.phonemes) phonemes += " ";
    phonemes += tk.phonemes ?? unk;
  }
  return phonemes;
}

function mergedUnderscore(tokens: readonly MToken[]): Underscore {
  const stresses = new Set(tokens.map((tk) => tk._.stress).filter((s) => s !== null));
  const currencies = tokens.map((tk) => tk._.currency).filter((c) => c !== null);
  const ratings = tokens.map((tk) => tk._.rating);
  const flags = new Set(tokens.flatMap((tk) => [...tk._.numFlags]));
  return underscore({
    isHead: tokens[0]!._.isHead,
    stress: stresses.size === 1 ? [...stresses][0]! : null,
    currency: currencies.length > 0 ? currencies.sort(byCodePoint).at(-1)! : null,
    numFlags: [...flags].sort(byCodePoint).join(""),
    prespace: tokens[0]!._.prespace,
    rating: ratings.includes(null) ? null : Math.min(...(ratings as number[])),
  });
}

/** misaki `merge_tokens`: one token spanning `tokens`; phonemes stay `null` unless `unk` is given. */
export function mergeTokens(tokens: readonly MToken[], unk: string | null = null): MToken {
  const last = tokens.at(-1)!;
  return {
    text: tokens.slice(0, -1).map((tk) => tk.text + tk.whitespace).join("") + last.text,
    tag: heaviestTag(tokens),
    whitespace: last.whitespace,
    phonemes: unk === null ? null : joinPhonemes(tokens, unk),
    rating: null,
    _: mergedUnderscore(tokens),
  };
}

const DIPHTHONGS = new Set("AIOQWYʤʧ");

export const stressWeight = (ps: string | null): number =>
  ps ? [...ps].reduce((n, c) => n + (DIPHTHONGS.has(c) ? 2 : 1), 0) : 0;
