import { readFileSync } from "node:fs";

/** Feature value as panphon writes it: `+` is 1, `-` is -1, `0` (not applicable) is 0. */
type FeatureValue = -1 | 0 | 1;
type FeatureVector = readonly FeatureValue[];

const TABLE_URL = new URL("../data/panphon/ipa_all.csv", import.meta.url);

// The tone columns (hitone, hireg) are not part of the segmental distance, so they are left out.
// A different panphon release changes this list, and loading then fails loudly.
export const FEATURE_NAMES: readonly string[] = [
  "syl", "son", "cons", "cont", "delrel", "lat", "nas", "strid", "voi", "sg", "cg",
  "ant", "cor", "distr", "lab", "hi", "lo", "back", "round", "velaric", "tense", "long",
];

/** The denominator of a substitution cost. */
export const FEATURE_COUNT: number = FEATURE_NAMES.length;

const TONE_FEATURES: ReadonlySet<string> = new Set(["hitone", "hireg"]);

/**
 * Symbols the English phone path produces that panphon spells differently. The right-hand side
 * is the panphon row; data/README.md records why each one was chosen.
 */
const ALIASES: Readonly<Record<string, string>> = {
  g: "ɡ",
  tʃ: "t͡ʃ",
  dʒ: "d͡ʒ",
  ᵻ: "ɨ",
  ɚ: "ə˞",
};

interface FeatureTable {
  rows: ReadonlyMap<string, FeatureVector>;
}

let cached: FeatureTable | undefined;

function parseValue(cell: string | undefined): FeatureValue {
  if (cell === "+") return 1;
  if (cell === "-") return -1;
  if (cell === "0") return 0;
  throw new Error(`panphon feature cell ${JSON.stringify(cell)} is not +, - or 0`);
}

/** Parses panphon's `ipa_all.csv` (CRLF line ends): a header row, then one segment per line, no quoting. */
export function parseFeatureCsv(text: string): FeatureTable {
  const [header = "", ...lines] = text.split(/\r?\n/).filter((line) => line !== "");
  const columns = header.split(",").slice(1);
  const kept = columns.flatMap((name, i) => (TONE_FEATURES.has(name) ? [] : [i]));
  const names = kept.map((i) => columns[i]);
  if (names.join() !== FEATURE_NAMES.join()) {
    throw new Error(`panphon header features ${names.join()} differ from ${FEATURE_NAMES.join()}`);
  }
  const rows = new Map<string, FeatureVector>();
  for (const line of lines) {
    const [ipa = "", ...cells] = line.split(",");
    const key = ipa.normalize("NFC");
    if (!rows.has(key)) rows.set(key, kept.map((i) => parseValue(cells[i])));
  }
  return { rows };
}

function table(): FeatureTable {
  cached ??= parseFeatureCsv(readFileSync(TABLE_URL, "utf8"));
  return cached;
}

/**
 * The feature vector of one phone segment, or `undefined` when panphon has no row for it
 * (diphthongs are not in panphon, and the caller prices unknown segments). Never throws on
 * an unknown symbol.
 */
export function featureVector(segment: string): FeatureVector | undefined {
  const key = segment.normalize("NFC");
  const { rows } = table();
  return rows.get(ALIASES[key] ?? key);
}
