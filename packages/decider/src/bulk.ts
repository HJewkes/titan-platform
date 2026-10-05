type BulkReason = "multi-item" | "plural-defaults" | "question-range";

interface BulkInput {
  recommended: string | null;
  answer: string | null;
  /** How many decisions the source says the one answer covered, when it knows. */
  covers: number | null;
}

interface BulkSignal {
  covers: number | null;
  reason: BulkReason;
}

const CLAUSE = "[^.;:!?\\n]*?";
const ACCEPT_WORD = "\\b(?:accept|ok|keep|take|leave|approve|recommend|all|every|plan|planner)\\b";
/** The plural is the signal: a singular "default" names one choice, not a batch. */
const PLURAL_DEFAULTS = [
  new RegExp(`${ACCEPT_WORD}${CLAUSE}\\b(?:defaults|recommended answers|recommendations)\\b`, "i"),
  new RegExp(`\\ball\\b${CLAUSE}\\bas (?:recommended|written)\\b`, "i"),
];

const NUMBER_WORDS = [
  "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const COUNT = `(\\d+|${NUMBER_WORDS.join("|")})`;
/** An id's number, as in "ZZ-343 defaults", is not a count. */
const COUNTED = new RegExp(`(?<![\\w-])${COUNT}\\s+(?:plan\\s+)?(?:qs|questions|defaults|plans|decisions)\\b`, "gi");
const LABEL_RANGE = /\b([QD])(\d+)\s*(?:-|–|to)\s*\1?(\d+)\b/gi;
const QUESTION_RANGE = /\bquestions?\s+(\d+)\s*(?:-|–|to)\s*(\d+)\b/gi;

function countOf(token: string): number {
  const word = NUMBER_WORDS.indexOf(token.toLowerCase());
  return word === -1 ? Number(token) : word + 2;
}

function rangeSize(low: string, high: string): number {
  return Number(high) - Number(low) + 1;
}

/** The largest count or range the text states, or null when it states none above one. */
function statedCount(text: string): number | null {
  const counts = [
    ...[...text.matchAll(COUNTED)].map((m) => countOf(m[1] ?? "")),
    ...[...text.matchAll(LABEL_RANGE)].map((m) => rangeSize(m[2] ?? "", m[3] ?? "")),
    ...[...text.matchAll(QUESTION_RANGE)].map((m) => rangeSize(m[1] ?? "", m[2] ?? "")),
  ].filter((n) => Number.isInteger(n) && n > 1);
  return counts.length === 0 ? null : Math.max(...counts);
}

/**
 * Whether one answer accepted several decisions at once. Reads only the recommendation and
 * the answer, never the question body; the first of multi-item, plural-defaults and
 * question-range to match names the reason.
 */
export function bulkSignal({ recommended, answer, covers }: BulkInput): BulkSignal | null {
  if (covers !== null && covers > 1) return { covers, reason: "multi-item" };
  const text = [answer, recommended].filter((t): t is string => t !== null).join("\n");
  const stated = statedCount(text);
  if (PLURAL_DEFAULTS.some((pattern) => pattern.test(text))) return { covers: stated, reason: "plural-defaults" };
  return stated === null ? null : { covers: stated, reason: "question-range" };
}
