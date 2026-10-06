import { stripRecommended } from "./outcome.js";

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
/**
 * Every form of an accept word, and the rest of its clause; the lookahead lets a later accept
 * word in that clause start its own. Keep, take and leave are left out: they choose a value
 * ("keep 10 questions per page"). So is recommend, which proposes rather than accepts.
 */
const ACCEPT_WORD = new RegExp(
  `(?<![\\w-])(?:accept(?:s|ed|ing)?|ok(?:ay)?(?:ed)?|yes|approv(?:e|es|ed|ing)|go(?:es|ing)? with|went with)\\b(?=(${CLAUSE}))`,
  "gi",
);
/** Punctuation and the small words between an accept word and its object, as in "yes to the". */
const LEAD = /^[\s,'"`“]*(?:(?:to|with|for|on|of|the|these|those)\s+)*/i;
/** A negation earlier in the clause, as in "I don't accept" or "not ok to go with". */
const NEGATION = /\b(?:not|never|cannot)\b|n['’]t\b/i;
/** "Only" scopes the acceptance to part of the batch, as in "all as written for Q2 only". */
const SCOPED = /\bonly\b/i;
const CLAUSE_SO_FAR = new RegExp(`${CLAUSE}$`);
/** A ticket id names a plan's batch, as in "ZZ-343 defaults"; "UTF-8" or "PR-1" is too short to be one. */
const ID = "[a-z]{2,}-\\d{2,}";

const NUMBER_WORDS = [
  "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const COUNT = `(\\d+|${NUMBER_WORDS.join("|")})`;
/** A rate, as in "10 questions per page", sizes one setting rather than counting decisions. */
const COUNTED_NOUN = `\\s+(?:plan\\s+)?(?:qs|questions|defaults|plans|decisions|recommendations|recommended answers)\\b(?!\\s+(?:per|each|at a time|in parallel)\\b)`;
/** An id's number, as in "ZZ-343 defaults", is not a count. */
const COUNTED = new RegExp(`(?<![\\w-])${COUNT}${COUNTED_NOUN}`, "gi");

/**
 * The plural is the signal, and only when the accepted object is a batch: all, every, a
 * count or a plan, or an id directly naming its defaults. "Accept the defaults" is one choice.
 */
const QUALIFIED_DEFAULTS = new RegExp(
  `^(?:(?:all|every|${COUNT}|plan|planner)\\b${CLAUSE}?\\b(?:defaults|recommended answers|recommendations)|${ID}\\s+(?:plan\\s+)?defaults)\\b`,
  "i",
);
const ALL_AS_WRITTEN = new RegExp(`^(?:all|every)\\b${CLAUSE}?\\bas (?:recommended|written)\\b`, "i");

/** "All of the" before a count or range, as in "ok to all 6 questions". */
const ALL_OF = /^(?:all|every)(?:\s+of)?(?:\s+(?:the|these|those))?\s+/i;
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

/**
 * What one accept word accepts: the rest of its clause, or the clause before it when it ends
 * the clause ("All nine defaults accepted"), with the lead-in stripped. Null when the word is
 * negated earlier in its clause, asked as a question, or scoped with "only".
 */
function acceptedObject(text: string, match: RegExpExecArray): string | null {
  const before = CLAUSE_SO_FAR.exec(text.slice(0, match.index))?.[0] ?? "";
  const after = match[1] ?? "";
  if (NEGATION.test(before) || text[match.index + match[0].length + after.length] === "?") return null;
  const following = after.replace(LEAD, "");
  const object = following.trim() === "" ? before.replace(LEAD, "") : following;
  return SCOPED.test(object.split(",")[0] ?? "") ? null : object;
}

/** The object of every accept word in the phrase; each matcher below reads only these. */
function acceptedObjects(phrase: string): string[] {
  return [...phrase.matchAll(ACCEPT_WORD)]
    .map((m) => acceptedObject(phrase, m))
    .filter((object): object is string => object !== null && object.trim() !== "");
}

/** The largest count the objects state, or null when none is plausible. */
function largestCount(objects: readonly string[]): number | null {
  const counts = objects.flatMap((object) => [...object.matchAll(COUNTED)].map((m) => countOf(m[1] ?? "")));
  const plausibleCounts = counts.filter((n) => plausible(n) !== null);
  return plausibleCounts.length === 0 ? null : Math.max(...plausibleCounts);
}

/** A count or range that is the accepted object, as in "yes to Q1-Q5"; never one further on. */
function governedCount(object: string): number | null {
  const head = object.replace(ALL_OF, "");
  const counted = GOVERNED_COUNT.exec(head);
  if (counted) return plausible(countOf(counted[1] ?? ""));
  const labels = GOVERNED_LABEL_RANGE.exec(head);
  if (labels) return plausible(rangeSize(labels[2], labels[3]));
  const questions = GOVERNED_QUESTION_RANGE.exec(head);
  return questions ? plausible(rangeSize(questions[1], questions[2])) : null;
}

/** A clause that is "all as written" needs no accept word: it is the acceptance. */
function allAsWritten(phrase: string): boolean {
  const clauses = phrase.split(/[.;:!?\n]/).map((clause) => clause.replace(LEAD, ""));
  return clauses.some((clause) => ALL_AS_WRITTEN.test(clause) && !SCOPED.test(clause));
}

/** Whether one phrase accepts a batch; it gives the same answer wherever the phrase appears. */
function phraseSignal(phrase: string): BulkSignal | null {
  const objects = acceptedObjects(phrase);
  const batches = objects.filter((object) => QUALIFIED_DEFAULTS.test(object) || ALL_AS_WRITTEN.test(object));
  if (batches.length > 0) return { covers: largestCount(batches), reason: "plural-defaults" };
  if (allAsWritten(phrase)) return { covers: null, reason: "plural-defaults" };
  const governed = objects.map(governedCount).find((n) => n !== null) ?? null;
  return governed === null ? null : { covers: governed, reason: "question-range" };
}

function withoutLabel(answer: string, label: string): string {
  const at = answer.toLowerCase().indexOf(label.toLowerCase());
  return at === -1 ? answer : `${answer.slice(0, at)}\n${answer.slice(at + label.length)}`;
}

/**
 * The text the owner adopted: the recommendation, which an accept or amend takes on, and the
 * words the owner added to it. The label is cut from the answer so it is read once.
 */
function adoptedPhrases(answer: string | null, recommended: string | null): string[] {
  const label = recommended === null ? "" : stripRecommended(recommended);
  const added = answer === null || label === "" ? answer : withoutLabel(answer, label);
  return [label, added ?? ""].filter((phrase) => phrase.trim() !== "");
}

/**
 * Whether one answer that accepted or amended the recommendation accepted several decisions
 * at once. Reads the recommendation and the owner's added words with one phrase rule, never
 * the question body; the first of multi-item, plural-defaults and question-range names the reason.
 */
export function bulkSignal({ recommended, answer, covers }: BulkInput): BulkSignal | null {
  if (covers !== null && covers > 1) return { covers, reason: "multi-item" };
  return adoptedPhrases(answer, recommended).map(phraseSignal).find((signal) => signal !== null) ?? null;
}
