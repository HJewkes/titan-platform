import {
  FeedbackSchema,
  ManifestSchema,
  type Answer,
  type Manifest,
  type ManifestInput,
  type Question,
} from "@titan-design/review-schema";
import type { z } from "zod";
import { prKey, roundAskKey } from "./keys.js";
import type { RoundQuestionBinding } from "./rounds.js";
import { ownerItemSchema, type OwnerAnswer, type OwnerItem } from "./schema.js";

export type FeedbackInput = z.input<typeof FeedbackSchema>;

export interface RoundItemsContext {
  /** When the round was served: round@2 carries no time of its own. */
  openedAt: string;
  /** What buildOwnerRounds returned with the manifest, so a question maps back to the item it asked. */
  bindings?: readonly RoundQuestionBinding[];
}

export interface AnsweredContext extends RoundItemsContext {
  roundId: string;
}

/** feedback@1 does not say who answered; only the owner answers a round. */
export const ROUND_ANSWERER: OwnerAnswer["by"] = { class: "owner", id: "owner", channel: "round" };

const MAX_SUMMARY = 280;
const MAX_OPTIONS = 8;

export function roundItemId(roundId: string, questionId: string): string {
  return `round:${roundId}/${questionId}`;
}

function summaryOf(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1)}…`;
}

function contextOf(question: Question, manifest: Manifest): string {
  const section = manifest.sections?.find((each) => each.questionIds.includes(question.id));
  return [section?.deciding, section?.context ?? manifest.context].filter((text) => text?.trim()).join("\n");
}

function optionId(label: string, binding: RoundQuestionBinding | undefined): string {
  return binding?.options[label] ?? label;
}

/** OwnerItem holds two to eight options; a question outside that range is asked as free text. */
function optionsOf(question: Question, binding: RoundQuestionBinding | undefined): OwnerItem["options"] {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  if (question.options.length < 2 || question.options.length > MAX_OPTIONS) return undefined;
  return question.options.map((label) => ({ id: optionId(label, binding), label }));
}

function recommendedOf(question: Question, manifest: Manifest, binding: RoundQuestionBinding | undefined): OwnerItem["recommended"] {
  if (question.kind !== "pick-one" || question.recommendation === undefined) return undefined;
  const { answer, by, confidence, rationale } = question.recommendation;
  if (typeof answer !== "string" || !question.options.includes(answer)) return undefined;
  const recommended = { optionId: optionId(answer, binding), by, confidence, rationale };
  return manifest.recommendations === "after-answer" ? { ...recommended, hidden: true } : recommended;
}

/** A bound single-item question is that item again; a principle settles several, so it stays a round item. */
function itemIdOf(roundId: string, question: Question, binding: RoundQuestionBinding | undefined): string {
  const only = binding?.principleId === undefined && binding?.itemIds.length === 1 ? binding.itemIds[0] : undefined;
  return only ?? roundItemId(roundId, question.id);
}

/** buildOwnerRounds asks only Decide items, so a bound question decides; a merge-bound one approves a head. */
function kindOf(question: Question, binding: RoundQuestionBinding | undefined): OwnerItem["kind"] {
  if (question.kind === "pick-one" && question.merge !== undefined) return "approve";
  return binding === undefined ? "review" : "decide";
}

function questionItem(question: Question, manifest: Manifest, roundId: string, context: RoundItemsContext): OwnerItem {
  const binding = context.bindings?.find((each) => each.questionId === question.id);
  const merge = question.kind === "pick-one" ? question.merge : undefined;
  const keys = [roundAskKey(manifest.unit, question.id)];
  if (merge !== undefined) keys.push(prKey(merge.repo, merge.pr, merge.headSha));
  const options = optionsOf(question, binding);
  const recommended = recommendedOf(question, manifest, binding);
  return ownerItemSchema.parse({
    id: itemIdOf(roundId, question, binding),
    sources: [{ system: "round", ref: `${roundId}#${question.id}` }],
    kind: kindOf(question, binding),
    door: "two-way",
    summary: summaryOf(question.prompt),
    context: contextOf(question, manifest),
    ...(options === undefined ? {} : { options }),
    ...(recommended === undefined ? {} : { recommended }),
    keys,
    personal: false,
    lens: merge === undefined ? "planning" : "blocking-merge",
    unblocks: [],
    openedAt: context.openedAt,
    status: "open",
  });
}

/**
 * Each round@2 question as an open OwnerItem, in question order. The item carries the question's
 * `ask:` key and, for a merge-bound question, the PR key pinned to its head. Throws when the
 * manifest or `openedAt` is invalid. Pure: no I/O and no clock.
 */
export function fromRoundQuestions(manifest: ManifestInput, roundId: string, context: RoundItemsContext): OwnerItem[] {
  const parsed = ManifestSchema.parse(manifest);
  return parsed.questions.map((question) => questionItem(question, parsed, roundId, context));
}

interface Picks {
  ids: string[];
  unoffered: string[];
}

/** Picks the item offers become option ids; any other pick is kept as text so nothing the owner chose is lost. */
function picksOf(answer: Answer, question: Question, binding: RoundQuestionBinding | undefined): Picks {
  const labels = question.kind === "pick-many" ? (answer.picks ?? []) : answer.pick === undefined ? [] : [answer.pick];
  const offered = optionsOf(question, binding) ?? [];
  const ids = labels.flatMap((label) => offered.find((option) => option.label === label)?.id ?? []);
  const unoffered = labels.filter((label) => !offered.some((option) => option.label === label));
  return { ids, unoffered };
}

function textOf(answer: Answer, unoffered: string[]): string | undefined {
  const given = answer.text ?? (answer.value === undefined ? undefined : String(answer.value));
  const parts = [given, unoffered.join(", "), answer.comment].filter((part): part is string => !!part?.trim());
  return parts.length === 0 ? undefined : parts.join("\n");
}

function choiceOf(question: Question, ids: string[]): Pick<OwnerAnswer, "optionId" | "optionIds"> {
  if (ids.length === 0) return {};
  return question.kind === "pick-many" ? { optionIds: ids } : { optionId: ids[0]! };
}

function ownerAnswer(answer: Answer, question: Question, binding: RoundQuestionBinding | undefined, at: string): OwnerAnswer | undefined {
  const { ids, unoffered } = picksOf(answer, question, binding);
  const text = textOf(answer, unoffered);
  const variantComments = answer.variantComments?.filter((each) => each.comment.trim() !== "") ?? [];
  const changeRequested = answer.revisionRequested === true;
  if (ids.length === 0 && text === undefined && variantComments.length === 0 && !changeRequested) return undefined;
  return {
    ...choiceOf(question, ids),
    ...(text === undefined ? {} : { text }),
    ...(changeRequested ? { changeRequested } : {}),
    ...(variantComments.length === 0 ? {} : { variantComments }),
    by: ROUND_ANSWERER,
    at,
  };
}

/**
 * The answered questions of a feedback@1 file as answered OwnerItems: the same items
 * fromRoundQuestions gives, with the owner's answer at `submittedAt`. With the round's bindings a
 * pick maps back to the option id of the item it asked. Questions left unanswered are omitted,
 * but a revision request is always kept, because it must still block a ship.
 * Throws when either file is invalid or the feedback is for another unit or round.
 */
export function answeredFromFeedback(feedback: FeedbackInput, manifest: ManifestInput, context: AnsweredContext): OwnerItem[] {
  const answers = FeedbackSchema.parse(feedback);
  const round = ManifestSchema.parse(manifest);
  if (answers.unit !== round.unit || answers.round !== round.round) {
    throw new Error(`feedback is for ${answers.unit} round ${answers.round}, the manifest is ${round.unit} round ${round.round}`);
  }
  const skipped = new Set(answers.unansweredQuestionIds ?? []);
  return answers.answers.flatMap((answer) => {
    const question = round.questions.find((each) => each.id === answer.questionId);
    if (question === undefined || (skipped.has(question.id) && answer.revisionRequested !== true)) return [];
    const binding = context.bindings?.find((each) => each.questionId === question.id);
    const given = ownerAnswer(answer, question, binding, answers.submittedAt);
    if (given === undefined) return [];
    return [{ ...questionItem(question, round, context.roundId, context), status: "answered" as const, answer: given }];
  });
}
