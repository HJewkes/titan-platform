import { isBlanketSignOff, isLoopbackUrl, MANIFEST_SCHEMA_ID, RoundSchema, type ManifestInput } from "@titan-design/review-schema";
import { z } from "zod";
import { ownerItemSchema, type OwnerItem } from "./schema.js";

type Recommended = NonNullable<OwnerItem["recommended"]>;
type QuestionInput = ManifestInput["questions"][number];
type SectionInput = NonNullable<ManifestInput["sections"]>[number];
type RecommendationInput = Extract<QuestionInput, { kind: "pick-one" }>["recommendation"];

/** The reason several asks would get one answer, written as one rule (TP-1535 rule 3). */
export interface Principle {
  id: string;
  /** One sentence: the rule and its limits. The covered items are listed after it. */
  rule: string;
  /** OwnerItem ids. One-way items are asked alone; with fewer than two left the items are asked alone. */
  covers: readonly string[];
  /** `optionId` is "yes" or "no". A hidden one puts the principle in an after-answer round. */
  recommended?: Recommended;
}

const principleSchema = z.object({
  id: z.string().min(1),
  rule: z.string().regex(/\S/),
  covers: z.array(z.string()),
  recommended: ownerItemSchema.shape.recommended,
});

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

/** A caller's configuration error, thrown before any item is read; round@2 would refuse the result. */
const optionsSchema = z.object({
  unit: z.string().regex(/\S/, "unit must not be blank"),
  storybookUrl: z.string().refine(isLoopbackUrl, "storybookUrl must be an http(s) URL on 127.0.0.1, localhost or [::1]"),
  firstRound: z.number().int().min(1).optional(),
  widths: z
    .array(z.number().int().min(200).max(3840))
    .min(1)
    .refine((widths) => new Set(widths).size === widths.length, "widths must not repeat")
    .optional(),
  maxQuestions: z.number().int().min(1).optional(),
});

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

export type SkipReason = "invalid" | "not-open" | "not-decide" | "routed-to-decider";

export interface OwnerRounds {
  rounds: OwnerRound[];
  skipped: { id: string; reason: SkipReason }[];
}

interface Ask {
  items: OwnerItem[];
  principle?: Principle;
  shadow: boolean;
}

/** An ask's raw text before `render` holds each field to round@2's rules. */
interface AskText {
  prompt: string;
  title: string;
  changed: string;
  context: string;
  choices?: { id: string; label: string }[];
  recommended?: Recommended;
  itemIds: string[];
  principleId?: string;
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

function itemIsShadow(item: OwnerItem, graduated: ReadonlySet<string>): boolean {
  if (item.recommended?.hidden === true) return true;
  return item.category === undefined || !graduated.has(item.category);
}

/** The one shadow decision: any hidden pick, on an item or on its principle, keeps the ask unshown. */
function askIsShadow(items: OwnerItem[], principle: Principle | undefined, graduated: ReadonlySet<string>): boolean {
  return principle?.recommended?.hidden === true || items.some((item) => itemIsShadow(item, graduated));
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
function toAsks(asked: OwnerItem[], principles: Principle[], graduated: ReadonlySet<string>): Ask[] {
  const claimed = claimPrinciples(asked, principles);
  const asks: Ask[] = [];
  const opened = new Set<Principle>();
  for (const item of asked) {
    const principle = claimed.get(item.id);
    if (principle === undefined) asks.push({ items: [item], shadow: askIsShadow([item], undefined, graduated) });
    if (principle === undefined || opened.has(principle)) continue;
    opened.add(principle);
    const items = asked.filter((each) => claimed.get(each.id) === principle);
    asks.push({ items, principle, shadow: askIsShadow(items, principle, graduated) });
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

/**
 * Every rendered text goes through here. round@2 refuses a blank section text, a blanket
 * sign-off in a prompt or option and an option shared by two pick-ones, so blank text takes
 * the fallback and the question id is appended until the text is none of those.
 */
function field(text: string, fallback: string, questionId: string, used = new Set<string>()): string {
  let shown = text.trim() === "" ? fallback : text.trim();
  while (used.has(shown) || isBlanketSignOff(shown)) shown = `${shown} (${questionId})`;
  used.add(shown);
  return shown;
}

function recommendation(recommended: Recommended | undefined, labels: Record<string, string>): RecommendationInput {
  if (recommended === undefined || recommended.confidence === undefined || recommended.by.trim() === "") return undefined;
  const answer = Object.keys(labels).find((label) => labels[label] === recommended.optionId);
  const cite = recommended.cite?.trim() ? `Cite: ${recommended.cite.trim()}` : undefined;
  const rationale = recommended.rationale?.trim() ? recommended.rationale.trim() : cite;
  if (answer === undefined || rationale === undefined) return undefined;
  return { answer, rationale, confidence: recommended.confidence, by: recommended.by.trim() };
}

function itemText(item: OwnerItem): AskText {
  return {
    prompt: item.summary,
    title: item.summary,
    changed: `New ask from ${item.asker ?? item.sources[0]!.system}, opened ${item.openedAt}`,
    context: item.context,
    choices: item.options?.map((option) => ({
      id: option.id,
      label: option.description?.trim() ? `${option.label.trim()}: ${option.description.trim()}` : option.label,
    })),
    recommended: item.recommended,
    itemIds: [item.id],
  };
}

function principleText(principle: Principle, items: OwnerItem[]): AskText {
  const covered = items.map((item, index) => `(${index + 1}) ${item.summary.trim() || item.id}`).join("; ");
  return {
    prompt: `Principle: ${principle.rule.trim()} It covers: ${covered}.`,
    title: `Principle covering ${items.length} asks`,
    changed: `${items.length} open asks share this rule; a yes settles each, a no asks each alone`,
    context: covered,
    choices: PRINCIPLE_OPTIONS,
    recommended: principle.recommended,
    itemIds: items.map((item) => item.id),
    principleId: principle.id,
  };
}

interface Rendered {
  question: QuestionInput;
  section: SectionInput;
  binding: RoundQuestionBinding;
}

/** The single boundary between an ask and round@2: every constrained field is normalised here. */
function renderAsk(text: AskText, questionId: string, used: Set<string>): Rendered {
  const prompt = field(text.prompt, "An ask with no summary", questionId);
  const section: SectionInput = {
    id: `s-${questionId}`,
    title: field(text.title, prompt, questionId),
    deciding: prompt,
    changed: field(text.changed, "A new ask", questionId),
    context: field(text.context, "No further context.", questionId),
    questionIds: [questionId],
  };
  const binding: RoundQuestionBinding = { questionId, itemIds: text.itemIds, options: {} };
  if (text.principleId !== undefined) binding.principleId = text.principleId;
  if (text.choices === undefined) return { question: { id: questionId, kind: "text", prompt }, section, binding };
  const labels: Record<string, string> = {};
  for (const choice of text.choices) labels[field(choice.label, "Option", questionId, used)] = choice.id;
  const question: QuestionInput = { id: questionId, kind: "pick-one", prompt, options: Object.keys(labels), signsOff: prompt };
  const shown = recommendation(text.recommended, labels);
  return {
    question: shown === undefined ? question : { ...question, recommendation: shown },
    section,
    binding: { ...binding, options: labels },
  };
}

function render(asks: Ask[], round: number, options: OwnerRoundOptions): OwnerRound {
  const used = new Set<string>();
  const rendered = asks.map((ask, index) =>
    renderAsk(ask.principle === undefined ? itemText(ask.items[0]!) : principleText(ask.principle, ask.items), `q${index + 1}`, used),
  );
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
  RoundSchema.parse(manifest);
  return { manifest, bindings: rendered.map((each) => each.binding) };
}

/** Inputs are parsed here, so a value only its TypeScript type vouches for never reaches a round. */
function admit(items: readonly OwnerItem[]): { asked: OwnerItem[]; skipped: OwnerRounds["skipped"] } {
  const skipped: OwnerRounds["skipped"] = [];
  const asked: OwnerItem[] = [];
  for (const raw of items) {
    const parsed = ownerItemSchema.safeParse(raw);
    const reason = parsed.success ? skipReason(parsed.data) : "invalid";
    if (reason === null) asked.push(parsed.data!);
    else skipped.push({ id: String(raw?.id ?? ""), reason });
  }
  return { asked, skipped };
}

/**
 * Turns open Decide items into titan-review/round@2 manifests, one question and one section per
 * ask, in input order (rank first). Items a principle covers become one `Principle:` question.
 * Asks with a shadow-mode item or a hidden pick go in rounds that reveal recommendations after
 * the answer; the rest go in rounds that show them. Pure: no I/O and no clock.
 *
 * Throws a ZodError on invalid options (a non-loopback storybookUrl, bad widths, a maxQuestions
 * or firstRound below 1), and every manifest is parsed with RoundSchema before it is returned.
 */
export function buildOwnerRounds(items: readonly OwnerItem[], options: OwnerRoundOptions): OwnerRounds {
  optionsSchema.parse(options);
  const { asked, skipped } = admit(items);
  const principles = (options.principles ?? []).flatMap((each) => {
    const parsed = principleSchema.safeParse(each);
    return parsed.success ? [parsed.data] : [];
  });
  const asks = toAsks(asked, principles, new Set(options.graduated ?? []));
  const first = options.firstRound ?? 1;
  const rounds = batch(asks, options.maxQuestions ?? 10);
  return { rounds: rounds.map((each, index) => render(each, first + index, options)), skipped };
}
