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
 * Each accept word and the rest of its clause; the lookahead lets a later accept word in that
 * clause start its own. Keep, take and leave are left out: they choose a value ("keep 10
 * questions per page"), they do not accept a batch.
 */
const ACCEPT_CLAUSE = new RegExp(`\\b(?:accept|ok|okay|yes|approve|recommend|go with)\\b(?=(${CLAUSE}))`, "gi");
const LEAD = /^[\s,'"`“]*(?:(?:to|with|the|all|of|these|those)\s+)*/i;
const OPEN = `^[\\s,'"\`“]*`;
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
const COUNTED_NOUN = `\\s+(?:plan\\s+)?(?:qs|questions|defaults|plans|decisions)\\b(?!\\s+(?:per|each|at a time|in parallel)\\b)`;
/** An id's number, as in "ZZ-343 defaults", is not a count. */
const COUNTED = new RegExp(`(?<![\\w-])${COUNT}${COUNTED_NOUN}`, "gi");

/**
 * The plural is the signal, and only when the accept word governs a batch: all, every, a
 * count or a plan, or an id directly naming its defaults. "Accept the defaults" is one choice.
 */
const QUALIFIED_DEFAULTS = new RegExp(
  `${OPEN}(?:the\\s+)?(?:(?:all|every|${COUNT}|plan|planner)\\b${CLAUSE}?\\b(?:defaults|recommended answers|recommendations)|${ID}\\s+(?:plan\\s+)?defaults)\\b`,
  "i",
);
const ALL_AS_WRITTEN = new RegExp(`${OPEN}all\\b${CLAUSE}?\\bas (?:recommended|written)\\b`, "i");
/** The accept word after the batch, as in "All nine defaults accepted". */
const BATCH_ACCEPTED = new RegExp(
  `${OPEN}(?:the\\s+)?(?:all|every|${COUNT})\\b${CLAUSE}?\\b(?:defaults|recommended answers|recommendations)\\b${CLAUSE}?\\b(?:accepted|approved)\\b`,
  "i",
);

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

/** An accept word negated earlier in its clause, or a clause asked as a question, accepts nothing. */
function accepts(text: string, match: RegExpExecArray): boolean {
  const clause = match[1] ?? "";
  if (NEGATION.test(CLAUSE_SO_FAR.exec(text.slice(0, match.index))?.[0] ?? "")) return false;
  return text[match.index + match[0].length + clause.length] !== "?";
}

/** The clause after each accept word that accepts something. */
function acceptClauses(text: string): string[] {
  return [...text.matchAll(ACCEPT_CLAUSE)].filter((m) => accepts(text, m)).map((m) => m[1] ?? "");
}

/** Whole clauses that end by accepting a batch, as in "All nine section 9 defaults accepted". */
function batchAcceptedClauses(text: string): string[] {
  return text.split(/[.;:!?\n]/).filter((clause) => BATCH_ACCEPTED.test(clause) && !NEGATION.test(clause));
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

function pluralDefaults(phrase: string, clauses: readonly string[]): BulkSignal | null {
  const governed = clauses.filter((clause) => QUALIFIED_DEFAULTS.test(clause) || ALL_AS_WRITTEN.test(clause));
  const matched = [...governed, ...batchAcceptedClauses(phrase)].filter((clause) => !SCOPED.test(clause));
  if (matched.length > 0) return { covers: largestCount(matched), reason: "plural-defaults" };
  return ALL_AS_WRITTEN.test(phrase) && !SCOPED.test(phrase) ? { covers: null, reason: "plural-defaults" } : null;
}

/** Whether one phrase accepts a batch; it gives the same answer wherever the phrase appears. */
function phraseSignal(phrase: string): BulkSignal | null {
  const clauses = acceptClauses(phrase);
  const plural = pluralDefaults(phrase, clauses);
  if (plural !== null) return plural;
  const governed = clauses.map(governedCount).find((n) => n !== null) ?? null;
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
