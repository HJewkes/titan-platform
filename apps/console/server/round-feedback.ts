/**
 * The review harness's feedback builder, ported: it turns the owner's posted answers and the round
 * on disk into a `titan-review/feedback@1` document, the same one the harness writes for the same
 * answers. Each answer echoes its question's recommendation, with `agreed` only once the question
 * is answered; the author's `revisionOption` sent as a pick is a revision request, never a pick.
 * Pure functions, no I/O.
 *
 * Product-side adapter (TP-1988): review-schema does not export the harness's `buildFeedback`,
 * `agrees`, `isAnswered`, `normalizeAnswer`, `unansweredQuestionIds` or `feedbackProblems`, so the
 * console and the harness judge answers by two copies. Delete this file when review-schema
 * releases them. The console answers no blind-ab round (`round-schema.ts`), so its rules are left out.
 */
import type { Feedback, Manifest, Question } from "./round-schema.js";
import { FEEDBACK_SCHEMA_ID, type PostedVariant, type SubmittedAnswer } from "./round2-adapter.js";

type Answer = Feedback["answers"][number];
type Recommendation = NonNullable<Answer["recommendation"]>;
type Variant = Manifest["variants"][number];
type Recommendable = Exclude<Question, { kind: "text" }>;

export interface PostedRound {
  answers: SubmittedAnswer[];
  general: string;
  variants?: PostedVariant[];
}

const takesRecommendation = (question: Question): question is Recommendable => question.kind !== "text";

/** A required pick-one gets the built-in revision option unless the author listed their own. */
function offersBuiltInRevision(question: Question): boolean {
  return question.kind === "pick-one" && question.required === true && !question.revisionOption;
}

/** The round's own `revisionOption` sent as a pick means the same as the built-in revision request. */
export function normalizeAnswer(question: Question, answer: Answer): Answer {
  if (question.kind !== "pick-one" || question.revisionOption === undefined) return answer;
  if (answer.pick !== question.revisionOption) return answer;
  const rest = { ...answer };
  delete rest.pick;
  return { ...rest, revisionRequested: true, ...(rest.recommendation ? { agreed: false } : {}) };
}

export function isAnswered(question: Question, given: Answer): boolean {
  const answer = normalizeAnswer(question, given);
  if (question.kind === "pick-one") return answer.pick !== undefined || answer.revisionRequested === true;
  if (question.kind === "pick-many") return (answer.picks ?? []).length > 0;
  if (question.kind === "scale") return answer.value !== undefined;
  return (answer.text ?? "").trim() !== "";
}

/** True when the owner's answer equals the recommended one; pick-many compares sets. */
export function agrees(answer: Answer, recommendation: Recommendation): boolean {
  if (answer.revisionRequested) return false;
  const given = answer.picks ?? answer.pick ?? answer.value;
  const wanted = recommendation.answer;
  if (!Array.isArray(wanted) || !Array.isArray(given)) return given === wanted;
  return given.length === wanted.length && wanted.every((option) => given.includes(option));
}

/** The picked option's `after`, which an answer echoes; a revision request picks nothing. */
function pickedAfter(question: Question, answer: Answer): string | undefined {
  if (question.kind !== "pick-one" || answer.pick === undefined) return undefined;
  return question.optionDetails?.[answer.pick]?.after;
}

/** A pick-one's pick or revision request; a stale request on a question that offers none is dropped. */
function choiceOf(question: Question, posted: SubmittedAnswer): Answer {
  const answer: Answer = { questionId: question.id };
  if (question.kind === "pick-one" && posted.pick !== undefined) return normalizeAnswer(question, { ...answer, pick: posted.pick });
  if (question.kind === "pick-one" && posted.revisionRequested && offersBuiltInRevision(question)) return { ...answer, revisionRequested: true };
  if (question.kind === "pick-many" && posted.picks?.length) return { ...answer, picks: posted.picks };
  if (question.kind === "scale" && posted.value !== undefined) return { ...answer, value: posted.value };
  if (question.kind === "text" && posted.text?.trim()) return { ...answer, text: posted.text };
  return answer;
}

/** The non-blank notes on the question's own options, in option order. */
function optionNotes(question: Question, posted: SubmittedAnswer): Answer["optionNotes"] {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  const notes = question.options.flatMap((option) => {
    const note = posted.optionNotes?.find((each) => each.option === option)?.note.trim();
    return note ? [{ option, note }] : [];
  });
  return notes.length > 0 ? notes : undefined;
}

/** In a `shown` round every recommendation was on screen, so an answer to a recommended question was not blind. */
function seenIn(manifest: Manifest, question: Question, answer: Answer): boolean {
  return manifest.recommendations === "shown" && takesRecommendation(question) && question.recommendation !== undefined && isAnswered(question, answer);
}

function withPacket(manifest: Manifest, question: Question, posted: SubmittedAnswer, answer: Answer): Answer {
  const notes = optionNotes(question, posted);
  const after = pickedAfter(question, answer);
  return {
    ...answer,
    ...(posted.comment?.trim() ? { comment: posted.comment } : {}),
    ...(notes ? { optionNotes: notes } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(seenIn(manifest, question, answer) ? { recommendationSeen: true as const } : {}),
  };
}

/** Echo the question's recommendation; `agreed` only once there is an answer to compare. */
function withRecommendation(question: Question, answer: Answer): Answer {
  if (!takesRecommendation(question) || !question.recommendation) return answer;
  const { recommendation } = question;
  return isAnswered(question, answer) ? { ...answer, recommendation, agreed: agrees(answer, recommendation) } : { ...answer, recommendation };
}

/** Null when the owner left the question untouched: no answer, comment or note. */
function toAnswer(manifest: Manifest, question: Question, posted: SubmittedAnswer | undefined): Answer | null {
  if (posted === undefined) return null;
  const answer = withPacket(manifest, question, posted, choiceOf(question, posted));
  return isAnswered(question, answer) || answer.comment || answer.optionNotes ? withRecommendation(question, answer) : null;
}

/** The questions the answers leave unanswered, in manifest order; a comment alone does not answer. */
export function unansweredQuestionIds(manifest: Manifest, answers: Answer[]): string[] {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  return manifest.questions
    .filter((question) => {
      const answer = byId.get(question.id);
      return answer === undefined || !isAnswered(question, answer);
    })
    .map((question) => question.id);
}

type Source = { storyId: string } | { image: string } | { clip: string } | { audio: string };

/** The frame's own source field, echoed so a reader needs no manifest. */
function sourceOf(variant: Variant): Source {
  if (variant.storyId !== undefined) return { storyId: variant.storyId };
  if (variant.audio !== undefined) return { audio: variant.audio };
  return variant.clip !== undefined ? { clip: variant.clip } : { image: variant.image ?? "" };
}

/** The owner's verdict, comment and pins over the frame's echo; the source and related questions are always the server's. */
function variantFeedback(manifest: Manifest, variant: Variant, posted: PostedVariant | undefined): Feedback["variants"][number] {
  const related = manifest.sections.find((section) => section.variantKeys.includes(variant.key))?.questionIds ?? [];
  return {
    key: variant.key,
    ...sourceOf(variant),
    verdict: posted?.verdict ?? null,
    comment: posted?.comment?.trim() ? posted.comment : "",
    annotations: posted?.annotations ?? [],
    ...(related.length > 0 ? { relatedQuestionIds: related } : {}),
  };
}

/** A partial build lists what was left out, which is what lets a required question go unanswered. */
export function buildRoundFeedback(manifest: Manifest, manifestSha256: string, posted: PostedRound, now: Date, partial = false): Feedback {
  const byId = new Map(posted.answers.map((answer) => [answer.questionId, answer]));
  const answers = manifest.questions.map((question) => toAnswer(manifest, question, byId.get(question.id))).filter((answer): answer is Answer => answer !== null);
  const unanswered = partial ? unansweredQuestionIds(manifest, answers) : [];
  const frames = new Map((posted.variants ?? []).map((variant) => [variant.key, variant]));
  return {
    schema: FEEDBACK_SCHEMA_ID,
    unit: manifest.unit,
    round: manifest.round,
    manifestSha256,
    submittedAt: now.toISOString(),
    answers,
    variants: manifest.variants.map((variant) => variantFeedback(manifest, variant, frames.get(variant.key))),
    general: posted.general,
    ...(unanswered.length > 0 ? { unansweredQuestionIds: unanswered } : {}),
  };
}

function revisionProblems(question: Question, answer: Answer): string[] {
  if (!answer.revisionRequested) return [];
  if (question.kind !== "pick-one") return [`${question.id}: only a pick-one can request a revision`];
  if (!offersBuiltInRevision(question) && question.revisionOption === undefined) return [`${question.id}: this question offers no revision request`];
  if (answer.pick !== undefined) return [`${question.id}: a revision request is not a pick`];
  return (answer.comment ?? "").trim() ? [] : [`${question.id}: a revision request needs a comment`];
}

function seenProblems(question: Question, answer: Answer): string[] {
  if (!answer.recommendationSeen) return [];
  if (!takesRecommendation(question) || !question.recommendation) return [`${question.id}: recommendationSeen on a question with no recommendation`];
  return isAnswered(question, answer) ? [] : [`${question.id}: recommendationSeen with no answer`];
}

/** Option notes, the echoed `after` and the seen tag must agree with the question and its answer. */
function packetProblems(question: Question, answer: Answer): string[] {
  const options = question.kind === "pick-one" || question.kind === "pick-many" ? question.options : [];
  return [
    ...(answer.optionNotes ?? []).filter((each) => !options.includes(each.option)).map((each) => `${question.id}: a note on "${each.option}", which is not an option`),
    ...(answer.after !== undefined && answer.after !== pickedAfter(question, answer) ? [`${question.id}: after is not the picked option's`] : []),
    ...seenProblems(question, answer),
  ];
}

function valueProblems(question: Question, answer: Answer): string[] {
  if (question.kind === "pick-one" && answer.pick !== undefined && !question.options.includes(answer.pick)) return [`${question.id}: unknown option`];
  const unknown = question.kind === "pick-many" ? (answer.picks ?? []).filter((pick) => !question.options.includes(pick)) : [];
  if (unknown.length > 0) return [`${question.id}: unknown options ${unknown.join(",")}`];
  const outOfRange = question.kind === "scale" && answer.value !== undefined && (answer.value < question.min || answer.value > question.max);
  return outOfRange ? [`${question.id}: value out of range`] : [];
}

function answerProblems(question: Question, given: Answer | undefined, skipped: boolean): string[] {
  const required = question.required === true && !skipped;
  if (given === undefined) return required ? [`${question.id}: required`] : [];
  const answer = normalizeAnswer(question, given);
  return [
    ...revisionProblems(question, answer),
    ...packetProblems(question, answer),
    ...valueProblems(question, answer),
    ...(required && !isAnswered(question, answer) ? [`${question.id}: required`] : []),
  ];
}

/** A partial submit must list exactly the questions it left unanswered, in manifest order. */
function unansweredProblems(feedback: Feedback, manifest: Manifest): string[] {
  const listed = feedback.unansweredQuestionIds;
  if (!listed) return [];
  const actual = unansweredQuestionIds(manifest, feedback.answers);
  return listed.join(",") === actual.join(",") ? [] : [`unansweredQuestionIds lists ${listed.join(", ")}; unanswered are ${actual.join(", ") || "none"}`];
}

/** A pin is addressed `<frame key>-<n>`, so its id must name the frame it sits on. */
export const isPinOf = (key: string, id: string): boolean => id.startsWith(`${key}-`) && /^[1-9][0-9]*$/.test(id.slice(key.length + 1));

function pinProblems(feedback: Feedback): string[] {
  return feedback.variants.flatMap(({ key, annotations }) => annotations.filter((pin) => !isPinOf(key, pin.id)).map((pin) => `${key}: pin "${pin.id}" is not one of its pins`));
}

/** Feedback that parses can still disagree with its manifest; list every disagreement. */
export function feedbackProblems(feedback: Feedback, manifest: Manifest): string[] {
  const answers = new Map(feedback.answers.map((answer) => [answer.questionId, answer]));
  const skipped = new Set(feedback.unansweredQuestionIds);
  const questionIds = new Set(manifest.questions.map((question) => question.id));
  const variantKeys = feedback.variants.map((variant) => variant.key).join(",");
  return [
    ...(feedback.unit !== manifest.unit || feedback.round !== manifest.round ? ["unit or round does not match the manifest"] : []),
    ...(variantKeys !== manifest.variants.map((variant) => variant.key).join(",") ? ["variants do not match the manifest"] : []),
    ...feedback.answers.filter((answer) => !questionIds.has(answer.questionId)).map((answer) => `${answer.questionId}: unknown`),
    ...manifest.questions.flatMap((question) => answerProblems(question, answers.get(question.id), skipped.has(question.id))),
    ...unansweredProblems(feedback, manifest),
    ...pinProblems(feedback),
  ];
}
