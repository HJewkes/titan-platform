import { z } from "zod";
import { chaptersOf, ODD_ONE_OUT_MIN_ITEMS, type ColdChapterBeats } from "./eval-cold.js";
import { canonicalSha } from "./eval-store.js";
import { EvidenceSchema, evalVersion, formatEvidence, voidReason } from "./eval-evidence.js";
import { explainItemRoutes, roleAsks, roleVersionParts, type ItemExplainRoute } from "./eval-items-roles.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { kindRoutes, spineSeats, type KindRoute, type SpineSeat } from "./eval-items-spine.js";
import { sumSpend, type CanaryResult } from "./eval-judge.js";
import { seatRoutes, type SeatReason, type SeatRoute } from "./lint-seat.js";
import type { PaceBeat } from "./pace-items.js";
import { contrastBeats, type SpineV1 } from "./spine-schema.js";

export const ITEMS_EVAL_ID = "L1-items";

export type ItemQuestionKind = "explained" | "seated" | "odd-one-out" | "kind-honest";

/** One list beat the item judge asks "which is a different kind of thing?" about. */
export interface ListRoute {
  beat: string;
  items: string[];
}

export type { ExplainRole, ItemExplainRoute } from "./eval-items-roles.js";

/** The L0 route lists: the item judge asks about these beats and items and nothing else. */
export interface ItemRoutes {
  explain: readonly ItemExplainRoute[];
  seat: readonly SeatRoute[];
  lists: readonly ListRoute[];
}

const listedItems = (beat: PaceBeat): string[] => beat.items.filter((i) => i.role === "item").map((i) => i.label);

/** Beats that put three or more items on screen, the same cut the cold probe asks its odd one out at. */
export function listRoutes(beats: readonly PaceBeat[]): ListRoute[] {
  return beats.flatMap((beat) => {
    const items = listedItems(beat);
    return items.length >= ODD_ONE_OUT_MIN_ITEMS ? [{ beat: beat.id, items }] : [];
  });
}

export const itemRoutes = (beats: readonly PaceBeat[], invariants: readonly string[]): ItemRoutes => ({
  explain: explainItemRoutes(beats),
  seat: seatRoutes(beats, invariants),
  lists: listRoutes(beats),
});

/** `subject` is the item asked about, the seat reason, or the listed items joined with "; ". */
export interface ItemQuestion {
  kind: ItemQuestionKind;
  beat: string;
  subject: string;
  options: string[];
  text: string;
}

const explainedText = (beat: string, item: string): string =>
  `In ${beat}, is "${item}" explained: does this beat or the rest of the chapter say what it is and why it is there?`;
const seatedText = (beat: string, reason: SeatReason): string =>
  `${beat} states ${reason === "invariant" ? "an invariant" : "a finding"}. Does the map on screen show the mechanism that keeps it, or the failure that breaks it?`;
const oddOneOutText = (beat: string, items: readonly string[]): string =>
  `In ${beat}, of ${items.map((i) => `"${i}"`).join(", ")}: which item is a different kind of thing, if any?`;

const explainedQuestion = (beat: string, item: string, text = explainedText): ItemQuestion => ({ kind: "explained", beat, subject: item, options: [], text: text(beat, item) });

function explainedQuestions(route: ItemExplainRoute): ItemQuestion[] {
  const asked = roleAsks(route);
  return asked.items.map((item) => explainedQuestion(route.beat, item, asked.text ?? explainedText));
}

/** Every question is read off a route, so a script cannot pass on questions written to suit it. */
export function itemQuestions(routes: ItemRoutes): ItemQuestion[] {
  return [
    ...routes.explain.flatMap(explainedQuestions),
    ...routes.seat.map((r): ItemQuestion => ({ kind: "seated", beat: r.beat, subject: r.reason, options: [], text: seatedText(r.beat, r.reason) })),
    ...routes.lists.map((r): ItemQuestion => ({ kind: "odd-one-out", beat: r.beat, subject: r.items.join("; "), options: r.items, text: oddOneOutText(r.beat, r.items) })),
  ];
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a");
const declaredList = (items: KindRoute["items"]): string => items.map((i) => `"${i.label}" ${article(i.kind)} ${i.kind}`).join(", ");
const kindHonestText = (beat: string, items: KindRoute["items"]): string =>
  `In ${beat}, the spine ledger declares ${declaredList(items)}. Which item is not the kind of thing it is declared to be, if any?`;
const seatedInText = (beat: string, part: string): string =>
  `${beat} states an invariant the spine says "${part}" keeps. Does the map on screen show "${part}" and the mechanism that keeps it, or the failure that breaks it?`;
const unseatedEvidence = (seat: SpineSeat): string =>
  seat.invariant === null ? "spine: no §3 invariant matches what this beat states" : `spine: no §4 part keeps "${seat.invariant}"`;

const kindHonestQuestion = (r: KindRoute): ItemQuestion => {
  const labels = r.items.map((i) => i.label);
  return { kind: "kind-honest", beat: r.beat, subject: labels.join("; "), options: labels, text: kindHonestText(r.beat, r.items) };
};

/** A seat the spine cannot pair is failed here, never posed: a map cannot show a part the plan never names. */
const unseatedVerdict = (seat: SpineSeat, i: number): ItemVerdict => ({
  qid: `s${i + 1}`,
  kind: "seated",
  beat: seat.beat,
  subject: "invariant",
  pass: false,
  picked: null,
  evidence: unseatedEvidence(seat),
  void_reason: null,
});

/** What a run asks the model, and the verdicts it reaches with no model call. */
interface QuestionPlan {
  questions: ItemQuestion[];
  ruled: ItemVerdict[];
}

function seatQuestions(routes: ItemRoutes, seats: ReadonlyMap<string, SpineSeat>): ItemQuestion[] {
  return routes.seat.flatMap((r) => {
    const seat = seats.get(r.beat);
    if (!seat) return itemQuestions({ explain: [], seat: [r], lists: [] });
    return seat.part === null ? [] : [{ kind: "seated", beat: r.beat, subject: r.reason, options: [], text: seatedInText(r.beat, seat.part) }];
  });
}

/**
 * With a spine, a list beat the ledger fully declares is asked whether each item is the kind declared, in place of
 * the blind odd one out, and an invariant seat is paired with its §4 part or failed without a call. A `contrast` beat
 * gets neither list question.
 */
function spinePlan(routes: ItemRoutes, beats: readonly PaceBeat[], spine: SpineV1): QuestionPlan {
  const kinds = kindRoutes(routes.lists, spine);
  const skipped = new Set([...kinds.map((k) => k.beat), ...contrastBeats(spine)]);
  const seats = spineSeats(beats, routes.seat, spine);
  const questions = [
    ...itemQuestions({ explain: routes.explain, seat: [], lists: [] }),
    ...seatQuestions(routes, seats),
    ...itemQuestions({ explain: [], seat: [], lists: routes.lists.filter((l) => !skipped.has(l.beat)) }),
    ...kinds.map(kindHonestQuestion),
  ];
  return { questions, ruled: [...seats.values()].filter((s) => s.part === null).map(unseatedVerdict) };
}

const questionPlan = (input: ItemsInput): QuestionPlan =>
  input.spine ? spinePlan(input.routes, input.beats, input.spine) : { questions: itemQuestions(input.routes), ruled: [] };

/** Made-up component names; the canary beat names them and says nothing more, so none of them is explained. */
export const CANARY_NAMES = ["brindle", "tessel", "quorn"] as const;
const CANARY_SPOKEN = `Three more parts sit here: ${CANARY_NAMES[0]}, ${CANARY_NAMES[1]} and ${CANARY_NAMES[2]}.`;

interface Canary {
  beat: PaceBeat;
  question: ItemQuestion;
  slot: number;
}

/** A name-only beat planted at the chapter's end; a nonce picks which name is asked about and where the question sits. */
function canaryFor(scriptSha: string, run: number, chapter: string): Canary {
  const nonce = canonicalSha({ eval_id: ITEMS_EVAL_ID, scriptSha, run, chapter });
  const id = `x${nonce.slice(0, 6)}`;
  const items = CANARY_NAMES.map((label) => ({ label, kind: "job", role: "item" as const, atS: null, source: "cue" as const }));
  const beat: PaceBeat = { id, chapter, fn: "WHAT", spoken: CANARY_SPOKEN, durationS: 6, timed: false, items, newItems: items, mapBeside: false };
  const name = CANARY_NAMES[Number.parseInt(nonce.slice(6, 12), 16) % CANARY_NAMES.length]!;
  return { beat, question: explainedQuestion(id, name), slot: Number.parseInt(nonce.slice(-6), 16) };
}

interface PosedQuestion {
  qid: string;
  question: ItemQuestion;
  canary: boolean;
}

function poseQuestions(questions: readonly ItemQuestion[], canary: Canary): PosedQuestion[] {
  const posed = questions.map((question) => ({ question, canary: false }));
  posed.splice(canary.slot % (posed.length + 1), 0, { question: canary.question, canary: true });
  return posed.map((q, i) => ({ qid: `q${i + 1}`, ...q }));
}

const spokenLine = (beat: PaceBeat): string => `spoken: ${beat.spoken}`;
const shownLines = (beat: PaceBeat): string[] => [
  ...(beat.items.length > 0 ? [`on screen: ${beat.items.map((i) => i.label).join("; ")}`] : []),
  `map on screen: ${beat.mapBeside ? "yes" : "no"}`,
];
const shownBody = (beat: PaceBeat): string => [spokenLine(beat), ...shownLines(beat)].join("\n");

/** The header is not quotable, so a judge cannot cite a beat's id as evidence. */
const renderBeat = (beat: PaceBeat): string => `[${beat.id}]\n${shownBody(beat)}`;

function itemsPrompt(rubric: string, chapter: string, beats: readonly PaceBeat[], posed: readonly PosedQuestion[]): string {
  const questions = posed.map((q) => `- ${q.qid}: ${q.question.text}`).join("\n");
  return `${rubric}\n\n## Chapter ${chapter}, in order\n\n${beats.map(renderBeat).join("\n\n")}\n\n## Questions\n\n${questions}\n`;
}

const AnswerSchema = z.strictObject({ qid: z.string(), pass: z.boolean(), odd_one_out: z.string().nullable(), evidence: z.array(EvidenceSchema) });
export type ItemAnswer = z.infer<typeof AnswerSchema>;
const ReplySchema = z.strictObject({ answers: z.array(AnswerSchema) });
type ItemsReply = JudgeReply<z.infer<typeof ReplySchema>>;

/** What a quote may be checked against: an "explained" yes must come from speech, any other verdict may cite the screen. */
export interface QuotableTexts {
  spoken: ReadonlyMap<string, string>;
  shown: ReadonlyMap<string, string>;
}

const quotableTexts = (beats: readonly PaceBeat[]): QuotableTexts => ({
  spoken: new Map(beats.map((b) => [b.id, spokenLine(b)])),
  shown: new Map(beats.map((b) => [b.id, shownBody(b)])),
});

/** `pass` is explained, seated, or (odd one out) no item stands apart; null when the verdict is void. */
export interface ItemVerdict {
  qid: string;
  kind: ItemQuestionKind;
  beat: string;
  subject: string;
  pass: boolean | null;
  picked: string | null;
  evidence: string;
  void_reason: string | null;
}

const pickOf = (answer: ItemAnswer, options: readonly string[]): string | undefined => {
  const key = answer.odd_one_out?.trim().toLowerCase();
  return options.find((o) => o.trim().toLowerCase() === key);
};

/** Kinds answered by picking one listed item, where passing means picking none. */
const isPick = (kind: ItemQuestionKind): boolean => kind === "odd-one-out" || kind === "kind-honest";

function voidOf(question: ItemQuestion, answer: ItemAnswer, texts: QuotableTexts): string | null {
  const cited = question.kind === "explained" && answer.pass ? texts.spoken : texts.shown;
  const reason = voidReason(answer.evidence, cited);
  if (reason) return reason;
  const strayPick = isPick(question.kind) && answer.odd_one_out !== null && pickOf(answer, question.options) === undefined;
  return strayPick ? `picks "${answer.odd_one_out}", which ${question.beat} does not list` : null;
}

/** Grades one answer; a verdict whose quotes are not verbatim in the beats they cite is void and never counts. */
export function gradeItemAnswer(qid: string, question: ItemQuestion, answer: ItemAnswer, texts: QuotableTexts): ItemVerdict {
  const base = { qid, kind: question.kind, beat: question.beat, subject: question.subject, evidence: formatEvidence(answer.evidence) };
  const reason = voidOf(question, answer, texts);
  if (reason) return { ...base, pass: null, picked: null, void_reason: reason };
  const picked = isPick(question.kind) ? (pickOf(answer, question.options) ?? null) : null;
  return { ...base, pass: isPick(question.kind) ? picked === null : answer.pass, picked, void_reason: null };
}

const unanswered = (qid: string, question: ItemQuestion, reply: ItemsReply): ItemVerdict => ({
  qid,
  kind: question.kind,
  beat: question.beat,
  subject: question.subject,
  pass: null,
  picked: null,
  evidence: "",
  void_reason: reply.ok ? "not answered" : `call failed: ${reply.reason}`,
});

/** The canary is passed only by a valid "not explained" verdict; a void or "explained" one is a miss. */
function canaryResult(verdict: ItemVerdict): CanaryResult {
  const got = verdict.pass === null ? "void" : verdict.pass ? "explained" : "not_explained";
  return { canary: `${verdict.beat}:${verdict.subject}`, dim: "explained", got, pass: got === "not_explained" };
}

/** `canary` is null for a chapter decided from the spine alone, which makes no call. */
export interface ItemsChapter {
  chapter: string;
  verdicts: ItemVerdict[];
  canary: CanaryResult | null;
}

function gradeChapter(beats: readonly PaceBeat[], posed: readonly PosedQuestion[], reply: ItemsReply): ItemsChapter {
  const texts = quotableTexts(beats);
  const graded = posed.map(({ qid, question, canary }) => {
    const answer = reply.ok ? reply.output.answers.find((a) => a.qid === qid) : undefined;
    return { canary, verdict: answer ? gradeItemAnswer(qid, question, answer, texts) : unanswered(qid, question, reply) };
  });
  const canary = graded.find((g) => g.canary)!.verdict;
  return { chapter: beats[0]!.chapter, verdicts: graded.filter((g) => !g.canary).map((g) => g.verdict), canary: canaryResult(canary) };
}

export interface ItemsInput {
  scriptSha: string;
  beats: readonly PaceBeat[];
  routes: ItemRoutes;
  rubric: string;
  judge: JudgeConfig;
  harness: JudgeHarness;
  run: number;
  /** The story spine the script was planned against; without one the run asks exactly what it did before E12. */
  spine?: SpineV1;
}

export interface ItemsResult {
  eval_version: string;
  judge: string;
  chapters: ItemsChapter[];
  failures: string[];
  trusted: boolean;
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

// The spine templates join the version only on spine runs, so every no-spine row stored before E12 keeps its version.
const spineQuestionTemplates = (): string[] => [
  kindHonestText("<beat>", [{ label: "<a>", kind: "step" }]),
  seatedInText("<beat>", "<part>"),
  unseatedEvidence({ beat: "<beat>", invariant: null, part: null }),
  unseatedEvidence({ beat: "<beat>", invariant: "<invariant>", part: null }),
];

export const itemsEvalVersion = (input: Pick<ItemsInput, "rubric" | "judge" | "spine">): string =>
  evalVersion(ITEMS_EVAL_ID, input.rubric, input.judge, {
    questions: [explainedText("<beat>", "<item>"), seatedText("<beat>", "invariant"), seatedText("<beat>", "finding"), oddOneOutText("<beat>", ["<a>", "<b>", "<c>"])],
    ...roleVersionParts(),
    canary: CANARY_SPOKEN,
    odd_one_out_min_items: ODD_ONE_OUT_MIN_ITEMS,
    ...(input.spine ? { spine_questions: spineQuestionTemplates() } : {}),
  });

interface JudgedChapter {
  reply: ItemsReply | null;
  graded: ItemsChapter;
}

async function judgeChapter(input: ItemsInput, chapter: ColdChapterBeats, questions: readonly ItemQuestion[], ruled: ItemVerdict[]): Promise<JudgedChapter> {
  if (questions.length === 0) return { reply: null, graded: { chapter: chapter.chapter, verdicts: ruled, canary: null } };
  const canary = canaryFor(input.scriptSha, input.run, chapter.chapter);
  const beats = [...chapter.beats, canary.beat];
  const posed = poseQuestions(questions, canary);
  const reply = await input.harness({ prompt: itemsPrompt(input.rubric, chapter.chapter, beats, posed), schema: ReplySchema });
  const graded = gradeChapter(beats, posed, reply);
  return { reply, graded: { ...graded, verdicts: [...graded.verdicts, ...ruled] } };
}

async function judgeChapters(input: ItemsInput, plan: QuestionPlan): Promise<JudgedChapter[]> {
  const judged = [];
  for (const chapter of chaptersOf(input.beats)) {
    const ids = new Set(chapter.beats.map((b) => b.id));
    const asked = plan.questions.filter((q) => ids.has(q.beat));
    const ruled = plan.ruled.filter((v) => ids.has(v.beat));
    if (asked.length + ruled.length > 0) judged.push(await judgeChapter(input, chapter, asked, ruled));
  }
  return judged;
}

/**
 * One item-judge run: a fresh tool-less call per chapter that has a routed question, with a name-only canary
 * beat planted in it. A run whose canary is not refused with evidence, or whose call failed, is not trusted.
 */
export async function runItems(input: ItemsInput): Promise<ItemsResult> {
  const judged = await judgeChapters(input, questionPlan(input));
  const replies = judged.flatMap((j) => (j.reply ? [j.reply] : []));
  const failures = replies.flatMap((reply) => (reply.ok ? [] : [reply.reason]));
  const chapters = judged.map((j) => j.graded);
  return {
    eval_version: itemsEvalVersion(input),
    judge: judgeLabel(input.judge),
    chapters,
    failures,
    trusted: failures.length === 0 && chapters.every((c) => c.canary?.pass ?? true),
    spend: sumSpend(replies),
  };
}

export interface ItemFlag {
  kind: ItemQuestionKind;
  beat: string;
  item: string;
}

const flagOf = (v: ItemVerdict): string | null => (isPick(v.kind) ? v.picked : v.pass === false ? v.subject : null);

/** Flags at least `quorum` runs agree on: not explained, not seated, or the same odd one out. One run's flag is noise. */
export function agreedFlags(runs: readonly ItemsResult[], quorum = 2): ItemFlag[] {
  const votes = new Map<string, { flag: ItemFlag; n: number }>();
  for (const verdict of runs.flatMap((r) => r.chapters.flatMap((c) => c.verdicts))) {
    const item = flagOf(verdict);
    if (item === null) continue;
    const key = JSON.stringify([verdict.kind, verdict.beat, item]);
    const tally = votes.get(key) ?? { flag: { kind: verdict.kind, beat: verdict.beat, item }, n: 0 };
    votes.set(key, { ...tally, n: tally.n + 1 });
  }
  return [...votes.values()].filter((v) => v.n >= quorum).map((v) => v.flag);
}
