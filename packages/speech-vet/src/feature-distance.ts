/**
 * A phone-feature edit distance over lv-60 segments. Substitutions are priced by panphon feature
 * mismatch; indels cost less than a full substitution, so a dropped coda is not as bad as a wrong word.
 */
import { FEATURE_COUNT, featureVector } from "./feature-table.js";
import { cleanIpa } from "./phones.js";

// Frozen in TP-3034 S2 by a grid over E5's seen recognitions; the fresh bar (S3) is scored with these.
// Changing either after that bar was read makes it post hoc.
/** The cost of inserting or deleting one segment. */
export const INDEL_COST = 0.6;
/** What a diphthong pays, on top of its closer component, against a single phone. */
export const GLIDE_COST = 0.4;

/** Overrides for the frozen costs, for the tuning grid and for tests that price another cost model. */
interface FeatureCosts {
  indel: number;
  glide: number;
}

const FROZEN: FeatureCosts = { indel: INDEL_COST, glide: GLIDE_COST };

// The multi-character tokens of the lv-60 vocab. tʃ and dʒ have panphon rows; the diphthongs do not,
// so they are priced from their two components.
const MULTI_SEGMENTS = ["eɪ", "aɪ", "oʊ", "aʊ", "ɔɪ", "tʃ", "dʒ"];
const ONE_PHONE = /^.\p{M}*/su;

type Vector = NonNullable<ReturnType<typeof featureVector>>;

/** Cleaned phones split greedily into lv-60 segments: a multi-character token, else a code point with its marks. */
export function phoneSegments(ipa: string): string[] {
  const phones = cleanIpa(ipa);
  const out: string[] = [];
  for (let i = 0; i < phones.length; ) {
    const segment = MULTI_SEGMENTS.find((m) => phones.startsWith(m, i)) ?? ONE_PHONE.exec(phones.slice(i))![0];
    out.push(segment);
    i += segment.length;
  }
  return out;
}

/** One vector for a phone panphon knows, two for a diphthong, `undefined` for anything else. */
function components(segment: string): Vector[] | undefined {
  const own = featureVector(segment);
  if (own) return [own];
  if (!MULTI_SEGMENTS.includes(segment)) return undefined;
  const parts = Array.from(segment).map(featureVector);
  return parts.every((v) => v !== undefined) ? parts : undefined;
}

function mismatch(a: Vector, b: Vector): number {
  let diff = 0;
  for (let i = 0; i < FEATURE_COUNT; i++) if (a[i] !== b[i]) diff++;
  return diff / FEATURE_COUNT;
}

/**
 * The substitution cost of `y` for `x`, in [0, 1]. A diphthong against a diphthong sums its component
 * costs, so splitting one into code points halves the price of an eɪ/aɪ swap; against a single phone it
 * pays the closer component plus `glide`. A segment panphon cannot price costs 1 against anything else.
 */
export function segmentCost(x: string, y: string, glide: number = GLIDE_COST): number {
  if (x === y) return 0;
  const a = components(x);
  const b = components(y);
  if (!a || !b) return 1;
  if (a.length === b.length) return Math.min(1, a.reduce((sum, v, i) => sum + mismatch(v, b[i]!), 0));
  const [pair, [single]] = a.length > b.length ? [a, b] : [b, a];
  return Math.min(1, Math.min(...pair.map((v) => mismatch(v, single!))) + glide);
}

/** Weighted Levenshtein over segments, divided by the longer side's segment count. */
function editDistance(a: string[], b: string[], { indel, glide }: FeatureCosts): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j * indel);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i * indel];
    for (let j = 1; j <= b.length; j++) {
      const substitute = prev[j - 1]! + segmentCost(a[i - 1]!, b[j - 1]!, glide);
      cur[j] = Math.min(prev[j]! + indel, cur[j - 1]! + indel, substitute);
    }
    prev = cur;
  }
  return prev[b.length]! / Math.max(a.length, b.length);
}

/** Normalized phone-feature distance in [0, 1] after cleaning both sides; 0 is the same pronunciation. */
export function featureDistance(expected: string, actual: string, costs: FeatureCosts = FROZEN): number {
  const a = phoneSegments(expected);
  const b = phoneSegments(actual);
  if (!a.length && !b.length) return 0;
  return editDistance(a, b, costs);
}
