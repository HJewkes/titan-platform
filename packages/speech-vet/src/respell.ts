import { escapeRegExp } from "./regexp.js";

const RESERVED_KEYS = new Set(["_comment"]);

/** Whole-word, case-insensitive respelling of hard-to-pronounce words, for a voice whose only lever is the spelling. */
export interface Respeller {
  readonly entries: Readonly<Record<string, string>>;
  /** Replaces every entry's word with its respelling; idempotent while no respelling is itself a key. */
  apply(text: string): string;
}

export function wholeWords(keys: readonly string[]): RegExp | null {
  if (keys.length === 0) return null;
  // Longest first, so a key that prefixes another never wins the alternation.
  const alternatives = [...keys].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

export function respeller(map: Readonly<Record<string, string>>): Respeller {
  const entries = Object.fromEntries(Object.entries(map).filter(([key]) => !RESERVED_KEYS.has(key)));
  const lower = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  const pattern = wholeWords(Object.keys(entries));
  return {
    entries,
    apply: (text) => (pattern === null ? text : text.replace(pattern, (word) => lower.get(word.toLowerCase()) ?? word)),
  };
}

// English spelling irregularities a voice routinely trips on. Each is tried alone and accreted onto the previous ones.
const RESPELL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^wr/gi, "r"],
  [/^kn/gi, "n"],
  [/ph/gi, "f"],
  [/ough/gi, "ow"],
  [/augh/gi, "aw"],
  [/x/gi, "ks"],
  [/y/gi, "i"],
  [/ch/gi, "k"],
  [/e$/gi, ""],
  [/ham$/gi, "um"],
  [/shawe$/gi, "shaw"],
  [/([bcdfghjklmnpqrstvwxz])\1/gi, "$1"],
];

function matchCase(variant: string, original: string): string {
  const first = original.slice(0, 1);
  if (first !== first.toLowerCase() && variant) return variant[0]!.toUpperCase() + variant.slice(1);
  return variant;
}

/** Heuristic respelling candidates for a hard word, in rule order, without the word itself or case-insensitive repeats. */
export function generateCandidates(word: string, limit = 12): string[] {
  const out: string[] = [];
  const seen = new Set([word.toLowerCase()]);
  let cumulative = word;
  for (const [rule, replacement] of RESPELL_RULES) {
    for (const base of [word, cumulative]) {
      const variant = matchCase(base.replace(rule, replacement), word);
      if (variant && !seen.has(variant.toLowerCase())) {
        seen.add(variant.toLowerCase());
        out.push(variant);
      }
    }
    cumulative = cumulative.replace(rule, replacement);
  }
  return out.slice(0, limit);
}
