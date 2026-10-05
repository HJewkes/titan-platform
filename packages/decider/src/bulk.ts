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

/** Past this a count reads as a year, a percentage or a size, not a batch of decisions. */
const MAX_COVERS = 50;
const CLAUSE = "[^.;:!?\\n]*";
/** Each accept word and the rest of its clause; the lookahead lets a later accept word in that clause start its own. */
const ACCEPT_CLAUSE = new RegExp(`\\b(?:accept|ok|okay|yes|keep|take|leave|approve|recommend|go with)\\b(?=(${CLAUSE}))`, "gi");
const LEAD = /^[\s,'"`“]*(?:(?:to|with|the|all|of|these|those)\s+)*/i;

const NUMBER_WORDS = [
  "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const COUNT = `(\\d+|${NUMBER_WORDS.join("|")})`;
const COUNTED_NOUN = `\\s+(?:plan\\s+)?(?:qs|questions|defaults|plans|decisions)\\b`;
/** An id's number, as in "ZZ-343 defaults", is not a count. */
const COUNTED = new RegExp(`(?<![\\w-])${COUNT}${COUNTED_NOUN}`, "gi");

/**
 * The plural is the signal, and only when the accept word governs a batch: all, every, a
 * count, an id or a plan. "Keep the defaults" is one choice and never matches.
 */
const QUALIFIED_DEFAULTS = new RegExp(
  `^[\\s,'"\`“]*(?:the\\s+)?(?:all|every|${COUNT}|[a-z]+-\\d+|plan|planner)\\b${CLAUSE}?\\b(?:defaults|recommended answers|recommendations)\\b`,
  "i",
);
const ALL_AS_WRITTEN = new RegExp(`^\\s*all\\b${CLAUSE}?\\bas (?:recommended|written)\\b`, "i");

const GOVERNED_COUNT = new RegExp(`^${COUNT}${COUNTED_NOUN}`, "i");
const GOVERNED_LABEL_RANGE = /^([QD])(\d+)\s*(?:-|–|to)\s*\1(\d+)\b/i;
const GOVERNED_QUESTION_RANGE = /^questions?\s+(\d+)\s*(?:-|–|to)\s*(\d+)\b/i;

function countOf(token: string): number {
  const word = NUMBER_WORDS.indexOf(token.toLowerCase());
  return word === -1 ? Number(token) : word + 2;
}

function plausible(n: number): number | null {
  return Number.isInteger(n) && n > 1 && n <= MAX_COVERS ? n : null;
}

function rangeSize(low: string | undefined, high: string | undefined): number {
  return Number(high) - Number(low) + 1;
}

function acceptClauses(text: string): string[] {
  return [...text.matchAll(ACCEPT_CLAUSE)].map((m) => m[1] ?? "");
}

/** The largest count the clauses state, or null when none is plausible. */
function largestCount(clauses: readonly string[]): number | null {
  const counts = clauses.flatMap((clause) => [...clause.matchAll(COUNTED)].map((m) => countOf(m[1] ?? "")));
  const plausibleCounts = counts.filter((n) => plausible(n) !== null);
  return plausibleCounts.length === 0 ? null : Math.max(...plausibleCounts);
}

/** A count or range the accept word takes as its object, as in "yes to Q1-Q5"; never one further on. */
function governedCount(clause: string): number | null {
  const object = clause.replace(LEAD, "");
  const counted = GOVERNED_COUNT.exec(object);
  if (counted) return plausible(countOf(counted[1] ?? ""));
  const labels = GOVERNED_LABEL_RANGE.exec(object);
  if (labels) return plausible(rangeSize(labels[2], labels[3]));
  const questions = GOVERNED_QUESTION_RANGE.exec(object);
  return questions ? plausible(rangeSize(questions[1], questions[2])) : null;
}

function pluralDefaults(answer: string | null, clauses: readonly string[]): BulkSignal | null {
  const matched = clauses.filter((clause) => QUALIFIED_DEFAULTS.test(clause) || ALL_AS_WRITTEN.test(clause));
  if (matched.length > 0) return { covers: largestCount(matched), reason: "plural-defaults" };
  return answer !== null && ALL_AS_WRITTEN.test(answer) ? { covers: null, reason: "plural-defaults" } : null;
}

/**
 * Whether one answer accepted several decisions at once. Reads only the recommendation and
 * the answer, never the question body, and only inside a clause an accept word opens; the
 * first of multi-item, plural-defaults and question-range to match names the reason.
 */
export function bulkSignal({ recommended, answer, covers }: BulkInput): BulkSignal | null {
  if (covers !== null && covers > 1) return { covers, reason: "multi-item" };
  const text = [answer, recommended].filter((t): t is string => t !== null).join("\n");
  const clauses = acceptClauses(text);
  const plural = pluralDefaults(answer, clauses);
  if (plural !== null) return plural;
  const governed = clauses.map(governedCount).find((n) => n !== null) ?? null;
  return governed === null ? null : { covers: governed, reason: "question-range" };
}
