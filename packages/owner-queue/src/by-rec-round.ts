import type { Manifest, Question } from "@titan-design/review-schema";
import type { ByRecRecommendation, ByRecSubject } from "./by-rec-floor.js";
import { contextOf, roundItemId, summaryOf } from "./round-items.js";

export interface ByRecRoundContext {
  roundId: string;
  /** When the round's wait starts: a time the asker cannot set. */
  openedAt: string;
  /** The questions a plan approval binds (console `planApprovals`); review-schema does not carry them. */
  planApprovalIds?: readonly string[];
}

type RoundManifest = Pick<Manifest, "sections" | "context" | "recommendations">;

/** Any recommendation the round would submit counts, pick-many and scale included, so the floor sees what gets answered. */
function recommendationOf(question: Question): ByRecRecommendation | undefined {
  if (question.kind === "text" || question.kind === "blind-ab" || question.recommendation === undefined) return undefined;
  const { answer, by, rationale, confidence } = question.recommendation;
  return { answer: Array.isArray(answer) ? answer.join(", ") : String(answer), by, rationale, confidence };
}

const MAX_SCALE_STEPS = 101;

function labelsOf(question: Question): string[] {
  return "options" in question && Array.isArray(question.options) ? question.options : [];
}

/**
 * The answers the floor checks a recommendation against. A pick-one offers its labels and a scale its whole steps. A
 * pick-many offers none: its answer is a set the floor cannot check against one list, so it refuses as answer-unsound,
 * and so does a scale too wide to list.
 */
function answerableOf(question: Question): string[] | undefined {
  if (question.kind === "pick-one") return question.options;
  if (question.kind !== "scale") return undefined;
  const steps = Math.floor(question.max) - Math.ceil(question.min) + 1;
  if (steps < 1 || steps > MAX_SCALE_STEPS) return undefined;
  return Array.from({ length: steps }, (_, index) => String(Math.ceil(question.min) + index));
}

function optionDetailText(question: Question): string[] {
  const details = "optionDetails" in question ? (question.optionDetails ?? {}) : {};
  return Object.values(details).flatMap(({ detail, weakPoint, after }) => [detail, weakPoint ?? "", after ?? ""]);
}

/**
 * A round@2 question as a by-rec subject: the one builder every reader of a round uses, the sweep that answers it and
 * the inbox line that says when it will, so both judge the same facts. `text` holds everything the owner reads with the
 * question (prompt, section or round context, option labels and details), so a dollar amount anywhere floors it.
 */
export function byRecRoundSubject(question: Question, manifest: RoundManifest, context: ByRecRoundContext): ByRecSubject {
  const recommendation = recommendationOf(question);
  const options = answerableOf(question);
  return {
    source: "round",
    id: roundItemId(context.roundId, question.id),
    openedAt: context.openedAt,
    summary: summaryOf(question.prompt),
    ...(recommendation && { recommendation }),
    kind: "decide",
    door: "two-way",
    blind: manifest.recommendations === "after-answer",
    ship: question.kind === "pick-one" && question.merge !== undefined,
    planApproval: context.planApprovalIds?.includes(question.id) === true,
    ...(options && { options }),
    text: [question.prompt, contextOf(question, manifest), ...labelsOf(question), ...optionDetailText(question)],
  };
}
