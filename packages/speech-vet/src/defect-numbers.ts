// A port of the number grammar in the audiobook's validation/defects.py. Values are bigints
// because Python's int is unbounded: two different 20-digit readings must never compare equal.

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const UNITS = new Map(ONES.map((word, value) => [word, value]));
const TENS = new Map([
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
]);
const SCALES = new Map([
  ["thousand", 1000n],
  ["million", 1_000_000n],
]);
const DIGITS = /^[0-9]+$/;

type Prev = "unit" | "teen" | "ten" | "hundred" | undefined;
type Step = "next" | "stop" | "zero";

interface NumberScan {
  total: bigint;
  group: bigint;
  prev: Prev;
}

/** The value of one number token, a digit run or a single number word ("50", "fifty"). */
export function numericValue(word: string): bigint | undefined {
  if (DIGITS.test(word)) return BigInt(word);
  const value = UNITS.get(word) ?? TENS.get(word);
  return value === undefined ? undefined : BigInt(value);
}

/**
 * Parses an English cardinal starting at `norms[i]`: `[value, end]`, or `[null, i]` when none
 * starts there. Grammar-aware, so "one thirty six" reads as 1 then 36, and it stops at "and".
 */
export function scanNumber(norms: readonly string[], i: number): [value: bigint | null, end: number] {
  if (DIGITS.test(norms[i] ?? "")) return [BigInt(norms[i]!), i + 1];
  const scan: NumberScan = { total: 0n, group: 0n, prev: undefined };
  let j = i;
  for (; j < norms.length; j++) {
    const step = advance(scan, norms[j]!, j > i);
    if (step === "zero") return [0n, j + 1];
    if (step === "stop") break;
  }
  return j > i ? [scan.total + scan.group, j] : [null, i];
}

function advance(scan: NumberScan, word: string, used: boolean): Step {
  const unit = UNITS.get(word);
  if (unit !== undefined) return addUnit(scan, unit, used);
  const ten = TENS.get(word);
  if (ten !== undefined) {
    if (scan.prev !== undefined && scan.prev !== "hundred") return "stop";
    scan.group += BigInt(ten);
    scan.prev = "ten";
    return "next";
  }
  if (word === "hundred") {
    if (!used || scan.prev === "hundred") return "stop";
    scan.group = (scan.group || 1n) * 100n;
    scan.prev = "hundred";
    return "next";
  }
  const scale = SCALES.get(word);
  if (scale === undefined || !used) return "stop";
  scan.total += (scan.group || 1n) * scale;
  scan.group = 0n;
  scan.prev = undefined;
  return "next";
}

function addUnit(scan: NumberScan, value: number, used: boolean): Step {
  if (value === 0) return used ? "stop" : "zero";
  if (value < 10 && (scan.prev === "unit" || scan.prev === "teen")) return "stop";
  if (value >= 10 && scan.prev !== undefined && scan.prev !== "hundred") return "stop";
  scan.group += BigInt(value);
  scan.prev = value < 10 ? "unit" : "teen";
  return "next";
}
