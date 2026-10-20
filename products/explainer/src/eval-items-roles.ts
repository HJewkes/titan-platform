import { itemClauses } from "./lint-gloss.js";
import type { PaceBeat } from "./pace-items.js";

/** A beat role the plain "explained" question does not fit. */
export type ExplainRole = "promise" | "simplification" | "cast" | "question";

// A PROMISE previews items later chapters deliver, and a CAVEAT voices the script's simplifications: what it leaves out.
const FN_ROLES = new Map<string, ExplainRole>([["PROMISE", "promise"], ["CAVEAT", "simplification"]]);

/** Words naming a person or a role a person holds, so a clause built on one introduces someone, not something. */
export const PERSON_WORDS = [
  "you", "we", "owner", "reviewer", "coordinator", "implementer", "planner", "researcher", "operator",
  "user", "author", "maintainer", "engineer", "developer", "person", "people", "human",
] as const;
const PERSONS = new Set<string>(PERSON_WORDS);

const wordsOf = (clause: string): string[] =>
  clause
    .toLowerCase()
    .split(/[^a-z']+/)
    .map((w) => w.replace(/'s$/, "").replace(/s$/, ""));

const namesPerson = (clause: string | undefined): boolean => clause !== undefined && wordsOf(clause).some((w) => PERSONS.has(w));

/** A cast line introduces who is around ("a reviewer, a coordinator seat, and you"): every item's own clause names a person. */
function isCastLine(beat: PaceBeat): boolean {
  const clauses = [...itemClauses(beat).values()];
  return clauses.length > 0 && clauses.every(namesPerson);
}

/** A label that gives the answer to a question rather than naming a thing: "default: yes". */
export const ANSWER_LABEL = /^defaults?\s*:/i;
export const isAnswerLabel = (label: string): boolean => ANSWER_LABEL.test(label.trim());

/** An owner-question beat puts open questions on screen and then an answer label for them. */
const isOwnerQuestion = (beat: PaceBeat): boolean =>
  beat.items.some((item, i) => isAnswerLabel(item.label) && beat.items.slice(0, i).some((q) => q.kind === "open" && !isAnswerLabel(q.label)));

export function explainRole(beat: PaceBeat): ExplainRole | undefined {
  const byFn = FN_ROLES.get(beat.fn);
  if (byFn) return byFn;
  if (isCastLine(beat)) return "cast";
  return isOwnerQuestion(beat) ? "question" : undefined;
}
