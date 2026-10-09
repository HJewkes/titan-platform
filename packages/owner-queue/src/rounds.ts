import { isBlanketSignOff, MANIFEST_SCHEMA_ID, type ManifestInput } from "@titan-design/review-schema";
import type { OwnerItem } from "./schema.js";

type Recommended = NonNullable<OwnerItem["recommended"]>;
type QuestionInput = ManifestInput["questions"][number];
type SectionInput = NonNullable<ManifestInput["sections"]>[number];
type RecommendationInput = Extract<QuestionInput, { kind: "pick-one" }>["recommendation"];

/** The reason several asks would get one answer, written as one rule (TP-1535 rule 3). */
export interface Principle {
  id: string;
  /** One sentence: the rule and its limits. The covered items are listed after it. */
  rule: string;
  /** OwnerItem ids. One-way items are asked alone; fewer than two left and no principle is asked. */
  covers: readonly string[];
  /** `optionId` is "yes" or "no". */
  recommended?: Recommended;
}

export interface OwnerRoundOptions {
  unit: string;
  /** A loopback Storybook URL; round@2 requires one even for a questions-only round. */
  storybookUrl: string;
  /** The first round's number; later rounds count up from it. Default 1. */
  firstRound?: number;
  /** Default [1280]. */
  widths?: number[];
  /** Categories graduated from shadow mode, whose recommendations a round shows from the start. */
  graduated?: readonly string[];
  principles?: readonly Principle[];
  /** Questions per round; a principle counts as one. Default 10. */
  maxQuestions?: number;
}

export interface RoundQuestionBinding {
  questionId: string;
  /** The item asked, or every item the principle covers. */
  itemIds: string[];
  principleId?: string;
  /** Shown option label to the item's option id ("yes" or "no" for a principle). */
  options: Record<string, string>;
}

export interface OwnerRound {
  manifest: ManifestInput;
  bindings: RoundQuestionBinding[];
}

export type SkipReason = "not-open" | "not-decide" | "routed-to-decider";

export interface OwnerRounds {
  rounds: OwnerRound[];
  skipped: { id: string; reason: SkipReason }[];
}

interface Ask {
  items: OwnerItem[];
  principle?: Principle;
  shadow: boolean;
}

const PRINCIPLE_OPTIONS = [
  { id: "yes", label: "Yes: the decider settles each covered item by this rule" },
  { id: "no", label: "No: ask me each covered item on its own" },
];

function skipReason(item: OwnerItem): SkipReason | null {
  if (item.status !== "open") return "not-open";
  if (item.kind !== "decide") return "not-decide";
  return item.route?.target === "decider" ? "routed-to-decider" : null;
}

function isShadow(item: OwnerItem, graduated: ReadonlySet<string>): boolean {
  if (item.recommended?.hidden === true) return true;
  return item.category === undefined || !graduated.has(item.category);
}

/** Each item belongs to the first principle that covers it; a one-way item never batches. */
function claimPrinciples(asked: OwnerItem[], principles: readonly Principle[]): Map<string, Principle> {
  const batchable = new Map(asked.filter((item) => item.door === "two-way").map((item) => [item.id, item]));
  const claimed = new Map<string, Principle>();
  for (const principle of principles) {
    const members = [...new Set(principle.covers)].filter((id) => batchable.has(id) && !claimed.has(id));
    if (members.length < 2) continue;
    for (const id of members) claimed.set(id, principle);
  }
  return claimed;
}

/** One ask per item or principle, placed where its first item stands in the input. */
function toAsks(asked: OwnerItem[], options: OwnerRoundOptions): Ask[] {
  const graduated = new Set(options.graduated ?? []);
  const claimed = claimPrinciples(asked, options.principles ?? []);
  const asks: Ask[] = [];
  const opened = new Set<Principle>();
  for (const item of asked) {
    const principle = claimed.get(item.id);
    if (principle === undefined) asks.push({ items: [item], shadow: isShadow(item, graduated) });
    if (principle === undefined || opened.has(principle)) continue;
    opened.add(principle);
    const items = asked.filter((each) => claimed.get(each.id) === principle);
    asks.push({ items, principle, shadow: items.some((each) => isShadow(each, graduated)) });
  }
  return asks;
}

/** Shadow and shown asks fill separate rounds, numbered in the order they open. */
function batch(asks: Ask[], max: number): Ask[][] {
  const rounds: Ask[][] = [];
  const filling = new Map<boolean, Ask[]>();
  for (const ask of asks) {
    let round = filling.get(ask.shadow);
    if (round === undefined) {
      round = [];
      rounds.push(round);
      filling.set(ask.shadow, round);
    }
    round.push(ask);
    if (round.length >= max) filling.delete(ask.shadow);
  }
  return rounds;
}

/** round@2 refuses an option shared by two pick-ones and a blanket sign-off, so either gets the question id. */
function distinct(text: string, used: Set<string>, questionId: string): string {
  const shown = used.has(text) || isBlanketSignOff(text) ? `${text} (${questionId})` : text;
  used.add(shown);
  return shown;
}

function recommendation(recommended: Recommended | undefined, labels: Record<string, string>): RecommendationInput {
  if (recommended === undefined || recommended.confidence === undefined) return undefined;
  const answer = Object.keys(labels).find((label) => labels[label] === recommended.optionId);
  const rationale = recommended.rationale ?? (recommended.cite === undefined ? undefined : `Cite: ${recommended.cite}`);
  if (answer === undefined || rationale === undefined) return undefined;
  return { answer, rationale, confidence: recommended.confidence, by: recommended.by };
}

interface Rendered {
  question: QuestionInput;
  section: SectionInput;
  binding: RoundQuestionBinding;
}

function pickOne(
  questionId: string,
  prompt: string,
  choices: { id: string; label: string }[],
  recommended: Recommended | undefined,
  used: Set<string>,
): { question: QuestionInput; labels: Record<string, string> } {
  const labels: Record<string, string> = {};
  for (const choice of choices) labels[distinct(choice.label, used, questionId)] = choice.id;
  const signsOff = isBlanketSignOff(prompt) ? `${prompt} (${questionId})` : prompt;
  const question: QuestionInput = { id: questionId, kind: "pick-one", prompt: signsOff, options: Object.keys(labels), signsOff };
  const shown = recommendation(recommended, labels);
  return { question: shown === undefined ? question : { ...question, recommendation: shown }, labels };
}

function itemQuestion(item: OwnerItem, questionId: string, used: Set<string>): Rendered {
  const section: SectionInput = {
    id: `s-${questionId}`,
    title: item.summary,
    deciding: item.summary,
    changed: `New ask from ${item.asker ?? item.sources[0]!.system}, opened ${item.openedAt}`,
    context: item.context.trim() === "" ? "No further context." : item.context,
    questionIds: [questionId],
  };
  const binding = { questionId, itemIds: [item.id], options: {} };
  if (item.options === undefined) return { question: { id: questionId, kind: "text", prompt: item.summary }, section, binding };
  const choices = item.options.map((option) => ({
    id: option.id,
    label: option.description === undefined ? option.label : `${option.label}: ${option.description}`,
  }));
  const { question, labels } = pickOne(questionId, item.summary, choices, item.recommended, used);
  return { question, section, binding: { ...binding, options: labels } };
}

function principleQuestion(principle: Principle, items: OwnerItem[], questionId: string, used: Set<string>): Rendered {
  const covered = items.map((item, index) => `(${index + 1}) ${item.summary}`).join("; ");
  const prompt = `Principle: ${principle.rule} It covers: ${covered}.`;
  const { question, labels } = pickOne(questionId, prompt, PRINCIPLE_OPTIONS, principle.recommended, used);
  const section: SectionInput = {
    id: `s-${questionId}`,
    title: `Principle covering ${items.length} asks`,
    deciding: principle.rule,
    changed: `${items.length} open asks share this rule; a yes settles each, a no asks each alone`,
    context: covered,
    questionIds: [questionId],
  };
  const binding = { questionId, itemIds: items.map((item) => item.id), principleId: principle.id, options: labels };
  return { question, section, binding };
}

function render(asks: Ask[], round: number, options: OwnerRoundOptions): OwnerRound {
  const used = new Set<string>();
  const rendered = asks.map((ask, index) => {
    const questionId = `q${index + 1}`;
    return ask.principle === undefined
      ? itemQuestion(ask.items[0]!, questionId, used)
      : principleQuestion(ask.principle, ask.items, questionId, used);
  });
  const manifest: ManifestInput = {
    schema: MANIFEST_SCHEMA_ID,
    unit: options.unit,
    round,
    storybookUrl: options.storybookUrl,
    widths: options.widths ?? [1280],
    variants: [],
    questions: rendered.map((each) => each.question),
    sections: rendered.map((each) => each.section),
    recommendations: asks[0]!.shadow ? "after-answer" : "shown",
  };
  return { manifest, bindings: rendered.map((each) => each.binding) };
}

/**
 * Turns open Decide items into titan-review/round@2 manifests, one question and one section per
 * ask, in input order (rank first). Items a principle covers become one `Principle:` question.
 * Shadow-mode asks go in rounds that reveal recommendations after the answer; asks whose every
 * item is in a graduated category go in rounds that show them. Pure: no I/O and no clock.
 */
export function buildOwnerRounds(items: readonly OwnerItem[], options: OwnerRoundOptions): OwnerRounds {
  const skipped: OwnerRounds["skipped"] = [];
  const asked: OwnerItem[] = [];
  for (const item of items) {
    const reason = skipReason(item);
    if (reason === null) asked.push(item);
    else skipped.push({ id: item.id, reason });
  }
  const first = options.firstRound ?? 1;
  const rounds = batch(toAsks(asked, options), options.maxQuestions ?? 10);
  return { rounds: rounds.map((asks, index) => render(asks, first + index, options)), skipped };
}
