import { explainRoutes, itemClauses, type ExplainRoute } from "./lint-gloss.js";
import type { PaceBeat } from "./pace-items.js";

/** A beat role the plain "explained" question does not fit. */
export type ExplainRole = "promise" | "simplification" | "cast" | "question";

/** An M3 route, with its beat's role when that changes what the judge is asked. */
export interface ItemExplainRoute extends ExplainRoute {
  role?: ExplainRole;
}

// A PROMISE previews items later chapters deliver, and a CAVEAT voices the script's simplifications: what it leaves out.
const FN_ROLES = new Map<string, ExplainRole>([["PROMISE", "promise"], ["CAVEAT", "simplification"]]);

/** Words naming a person or a role a person holds, so a clause built on one introduces someone, not something. */
const PERSON_WORDS = [
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
const ANSWER_LABEL = /^defaults?\s*:/i;
const isAnswerLabel = (label: string): boolean => ANSWER_LABEL.test(label.trim());

/** An owner-question beat puts open questions on screen and then an answer label for them. */
const isOwnerQuestion = (beat: PaceBeat): boolean =>
  beat.items.some((item, i) => isAnswerLabel(item.label) && beat.items.slice(0, i).some((q) => q.kind === "open" && !isAnswerLabel(q.label)));

function explainRole(beat: PaceBeat): ExplainRole | undefined {
  const byFn = FN_ROLES.get(beat.fn);
  if (byFn) return byFn;
  if (isCastLine(beat)) return "cast";
  return isOwnerQuestion(beat) ? "question" : undefined;
}

export function explainItemRoutes(beats: readonly PaceBeat[]): ItemExplainRoute[] {
  const byId = new Map(beats.map((b) => [b.id, b]));
  return explainRoutes(beats).map((r) => {
    const beat = byId.get(r.beat);
    const role = beat && explainRole(beat);
    return role ? { ...r, role } : r;
  });
}

type ItemText = (beat: string, item: string) => string;

const leftOutText: ItemText = (beat, item) =>
  `In ${beat}, "${item}" is left out on purpose: does this beat or the rest of the chapter say why the picture holds without it?`;
const ownerQuestionText: ItemText = (beat, item) =>
  `In ${beat}, "${item}" is a question put to the owner: does this beat or the rest of the chapter say what the owner is asked to decide?`;

/** The items a route's beat is asked about, and the role's own question text; `text` is null for the plain question. */
export interface RoleAsks {
  items: readonly string[];
  text: ItemText | null;
}

/**
 * A promise is not asked: its items are paid off in later chapters, which a chapter-scoped judge never sees. A cast
 * line is not asked either: it introduces people, who need no what-and-why. A simplification is asked why the picture
 * holds without each item, since explaining what it left out is not its job. An owner question is asked only what it
 * puts to the owner, and its answer label is not asked at all.
 */
export function roleAsks(route: ItemExplainRoute): RoleAsks {
  if (route.role === "promise" || route.role === "cast") return { items: [], text: null };
  if (route.role === "simplification") return { items: route.items, text: leftOutText };
  if (route.role === "question") return { items: route.items.filter((item) => !isAnswerLabel(item)), text: ownerQuestionText };
  return { items: route.items, text: null };
}

/** What the role questions and rules add to the item eval's version: changing either changes what is asked. */
export const roleVersionParts = () => ({
  role_questions: { promise: null, simplification: leftOutText("<beat>", "<item>"), cast: null, question: ownerQuestionText("<beat>", "<item>") },
  role_rules: { person_words: PERSON_WORDS, answer_label: ANSWER_LABEL.source },
});
