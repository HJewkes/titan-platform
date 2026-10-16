import { codePoints, sequenceDistance } from "./phones.js";

// Ported from jellyfish 1.2.1 (MIT, https://github.com/jamesturk/jellyfish): the pure-Python
// `metaphone` and `levenshtein_distance`. See NOTICE.
//
// One deliberate change from the Python fallback: a character past the end of the word is
// absent, not the sentinel "*****". jellyfish ships a Rust build that is what callers actually
// run, and it keeps `tough` as TKH, `dumb` as TM and `sign` as S, which the sentinel does not.

/** True when `ch` exists and is one of the characters in `set` (Python's `in` on a one-character string). */
function isOneOf(ch: string | undefined, set: string): boolean {
  return ch !== undefined && set.includes(ch);
}

const VOWELS = "aeiou";
const SKIPPED_OPENINGS = ["kn", "gn", "pn", "wr", "ae"];

interface Cursor {
  chars: string[];
  i: number;
  out: string[];
}

type Rule = (cur: Cursor, next: string | undefined, nextnext: string | undefined) => void;

const RULES: Record<string, Rule> = {
  b: ({ chars, i, out }, next) => {
    if (!(i !== 0 && chars[i - 1] === "m") || next !== undefined) out.push("b");
  },
  c: (cur, next, nextnext) => {
    if ((next === "i" && nextnext === "a") || next === "h") {
      cur.out.push("x");
      cur.i += 1;
    } else if (isOneOf(next, "iey")) {
      cur.out.push("s");
      cur.i += 1;
    } else cur.out.push("k");
  },
  d: (cur, next, nextnext) => {
    if (next === "g" && isOneOf(nextnext, "iey")) {
      cur.out.push("j");
      cur.i += 2;
    } else cur.out.push("t");
  },
  g: (cur, next, nextnext) => {
    if (isOneOf(next, "iey")) cur.out.push("j");
    else if (next === "h" && nextnext !== undefined && !VOWELS.includes(nextnext)) cur.i += 1;
    else if (next === "n" && nextnext === undefined) cur.i += 1;
    else cur.out.push("k");
  },
  h: ({ chars, i, out }, next) => {
    if (i === 0 || isOneOf(next, VOWELS) || !VOWELS.includes(chars[i - 1]!)) out.push("h");
  },
  k: ({ chars, i, out }) => {
    if (i === 0 || chars[i - 1] !== "c") out.push("k");
  },
  p: (cur, next) => {
    if (next === "h") {
      cur.out.push("f");
      cur.i += 1;
    } else cur.out.push("p");
  },
  q: ({ out }) => void out.push("k"),
  s: (cur, next, nextnext) => {
    if (next === "h") {
      cur.out.push("x");
      cur.i += 1;
    } else if (next === "i" && isOneOf(nextnext, "oa")) {
      cur.out.push("x");
      cur.i += 2;
    } else cur.out.push("s");
  },
  t: (cur, next, nextnext) => {
    if (next === "i" && isOneOf(nextnext, "oa")) cur.out.push("x");
    else if (next === "h") {
      cur.out.push("0");
      cur.i += 1;
    } else if (next !== "c" || nextnext !== "h") cur.out.push("t");
  },
  v: ({ out }) => void out.push("f"),
  w: (cur, next) => {
    if (cur.i === 0 && next === "h") {
      cur.i += 1;
      cur.out.push("w");
    } else if (isOneOf(next, VOWELS)) cur.out.push("w");
  },
  x: ({ i, out }, next, nextnext) => {
    if (i !== 0) out.push("k", "s");
    else if (next === "h" || (next === "i" && isOneOf(nextnext, "oa"))) out.push("x");
    else out.push("s");
  },
  y: ({ out }, next) => {
    if (isOneOf(next, VOWELS)) out.push("y");
  },
  z: ({ out }) => void out.push("s"),
  " ": ({ out }) => {
    if (out.length > 0 && out[out.length - 1] !== " ") out.push(" ");
  },
};
for (const letter of "fjlmnr") RULES[letter] = ({ out }) => void out.push(letter);

/** The metaphone code of `word`, equal to jellyfish 1.2.1's `metaphone` (Rust build). Empty when nothing is pronounceable. */
export function metaphone(word: string): string {
  let chars = codePoints(word.toLowerCase().normalize("NFKD"));
  if (SKIPPED_OPENINGS.includes(chars.slice(0, 2).join(""))) chars = chars.slice(1);

  const cur: Cursor = { chars, i: 0, out: [] };
  while (cur.i < chars.length) {
    const c = chars[cur.i]!;
    const next = chars[cur.i + 1];
    const nextnext = chars[cur.i + 2];
    if (c === next && c !== "c") {
      cur.i += 1;
      continue;
    }
    if (VOWELS.includes(c)) {
      if (cur.i === 0 || chars[cur.i - 1] === " ") cur.out.push(c);
    } else RULES[c]?.(cur, next, nextnext);
    cur.i += 1;
  }
  return cur.out.join("").toUpperCase();
}

/** Edit distance over code points, as jellyfish's `levenshtein_distance`. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const s1 = codePoints(a);
  const s2 = codePoints(b);
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  let prev: number[] = [];
  let cur = Array.from({ length: s2.length + 1 }, (_, c) => c);
  for (let r = 1; r <= s1.length; r++) {
    prev = cur;
    cur = [r, ...new Array<number>(s2.length).fill(0)];
    for (let c = 1; c <= s2.length; c++) {
      const edit = prev[c - 1]! + (s1[r - 1] === s2[c - 1] ? 0 : 1);
      cur[c] = Math.min(edit, prev[c]! + 1, cur[c - 1]! + 1);
    }
  }
  return cur[s2.length]!;
}

/** Normalized phonetic distance in [0, 1]; 0 is a homophone. Falls back to character distance when a side has no code (numbers, symbols). */
export function phoneticDistance(a: string, b: string): number {
  const ca = metaphone(a);
  const cb = metaphone(b);
  if (!ca || !cb) return sequenceDistance(codePoints(a), codePoints(b));
  if (ca === cb) return 0.0;
  const dist = levenshteinDistance(ca, cb);
  return Math.min(1.0, dist / Math.max(codePoints(ca).length, codePoints(cb).length, 1));
}
