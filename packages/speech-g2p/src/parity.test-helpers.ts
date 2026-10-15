/** A token reduced to what parity compares. `phonemes` is null when nothing was read. */
interface Reading {
  text: string;
  phonemes: string | null;
}

/** One reference word token beside the token the port gave for it, or null when the two runs split it differently. */
export interface Comparison {
  text: string;
  want: string | null;
  got: string | null;
  aligned: boolean;
  heteronym: boolean;
}

export interface Tally {
  tokens: number;
  agree: number;
  agreeNoStress: number;
  unaligned: number;
}

// The forms of the E4 heteronym table (motion-spike phonemes.py HETERONYMS): the C3 lint guards these, so they
// are reported but kept out of the parity bar.
const HETERONYM_FORMS = new Set(
  [
    "live lives read lead leads close wind winds tear tears wound wounds minute minutes record records",
    "present presents object objects content contents project projects produce produces use uses",
    "desert deserts refuse refuses row rows bow bows",
  ].flatMap((line) => line.split(" ")),
);
const STRESS = /[ˈˌ]/g;
const WORD = /[\p{L}\p{N}]/u;

export const stripStress = (ps: string | null): string => (ps ?? "").replace(STRESS, "");

// Longest common subsequence on token text, for a unit where the two runs merged tokens differently.
function align(a: readonly Reading[], b: readonly Reading[]): [Reading | null, Reading | null][] {
  if (a.length === b.length && a.every((t, i) => t.text === b[i]!.text)) return a.map((t, i) => [t, b[i]!]);
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i]!.text === b[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: [Reading | null, Reading | null][] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) pairs.push([a[i++]!, b[j++]!]);
    else if (j >= b.length || (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) pairs.push([a[i++]!, null]);
    else pairs.push([null, b[j++]!]);
  }
  return pairs;
}

/** Word tokens of the reference run, each with the port's reading of it. Tokens only the port has are skipped. */
export function compareUnit(want: readonly Reading[], got: readonly Reading[]): Comparison[] {
  return align(want, got).flatMap(([a, b]) =>
    a && WORD.test(a.text)
      ? [{ text: a.text, want: a.phonemes, got: b?.phonemes ?? null, aligned: b !== null, heteronym: HETERONYM_FORMS.has(a.text.toLowerCase()) }]
      : [],
  );
}

export const agrees = (c: Comparison): boolean => c.aligned && c.want === c.got;

/** Parity over non-heteronym word tokens, with and without stress marks. */
export function tally(comparisons: readonly Comparison[]): Tally {
  const counted = comparisons.filter((c) => !c.heteronym);
  return {
    tokens: counted.length,
    agree: counted.filter(agrees).length,
    agreeNoStress: counted.filter((c) => c.aligned && stripStress(c.want) === stripStress(c.got)).length,
    unaligned: counted.filter((c) => !c.aligned).length,
  };
}

export const percent = (n: number, of: number): number => Math.round((100_000 * n) / of) / 1000;
