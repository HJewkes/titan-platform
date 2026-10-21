import { z } from "zod";
import { canonicalSha } from "./eval-store.js";
import { EvidenceSchema, evalVersion, readRubric, voidReason } from "./eval-evidence.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sumSpend, type CanaryResult } from "./eval-judge.js";
import { agreedTerms, bareKey, bareListItems, listedLabels, spokenTerms } from "./eval-cold-terms.js";
import type { PaceBeat } from "./pace-items.js";

export const COLD_EVAL_ID = "L1-cold";
/** The viewer's whole memory of earlier chapters; anything longer would let the transcript leak forward. */
export const MAX_SUMMARY_LINES = 3;
/** A list this long is where a different kind of thing can hide among its neighbours. */
export const ODD_ONE_OUT_MIN_ITEMS = 3;
/** Viewer runs that name the spoken terms they cannot define; as with odd-one-out picks, two of three must agree. */
export const TERM_RUNS = 3;
export const TERM_QUORUM = 2;
export const COLD_TERMS_EVAL_ID = "L1-cold-terms";
export const COLD_TERMS_RUBRIC = "l1-cold-terms.md";
/** The rubric for spoken-term questions, asked in a call of their own so their stricter bar cannot reach item labels. */
export const COLD_SPOKEN_RUBRIC = "l1-cold-spoken.md";

type ScoredKind = "what-why" | "invariant" | "spoken-term" | "viewer-term";
const isTerm = (q: { kind: string }): boolean => q.kind === "spoken-term" || q.kind === "viewer-term";

export type ColdQuestion =
  | { kind: ScoredKind; beat: string; item: string; text: string }
  | { kind: "odd-one-out"; beat: string; items: string[]; text: string };

const whatWhyText = (item: string): string => `What is "${item}", and why is it there?`;
// A spoken term is asked what it means, under its own rubric, held to the readers' bar: a sentence that only uses it
// leaves it undefined. Item labels keep the looser bar; asked beside the stricter one, v4's ch9 went from 0 to 22 a minute.
const termText = (term: string): string => `What does "${term}" mean here, and why is it there?`;
const invariantText = (item: string): string => `"${item}" must always hold. What keeps it, or how does it break today?`;
const oddOneOutText = (items: readonly string[]): string =>
  `Of ${items.map((i) => `"${i}"`).join(", ")}: which item is a different kind of thing, if any?`;

/**
 * Every question comes from the item track, or from a term spoken before any label shows it (see `spokenTerms`), so a
 * script cannot pass on questions written to suit it. `glossary` is the script's own declared term list.
 */
export function coldQuestions(beats: readonly PaceBeat[], glossary: readonly string[] = [], viewerTerms: readonly string[] = []): ColdQuestion[] {
  const terms = spokenTerms(beats, glossary, viewerTerms);
  return beats.flatMap((beat): ColdQuestion[] => {
    const listed = listedLabels(beat);
    const heard = terms.filter((t) => t.beat === beat.id);
    return [
      ...beat.newItems.map((i) => ({ kind: "what-why" as const, beat: beat.id, item: i.label, text: whatWhyText(i.label) })),
      ...beat.newItems.filter((i) => i.kind === "inv").map((i) => ({ kind: "invariant" as const, beat: beat.id, item: i.label, text: invariantText(i.label) })),
      ...heard.map((t) => ({ kind: t.viewer ? ("viewer-term" as const) : ("spoken-term" as const), beat: beat.id, item: t.term, text: termText(t.term) })),
      ...(listed.length >= ODD_ONE_OUT_MIN_ITEMS ? [{ kind: "odd-one-out" as const, beat: beat.id, items: listed, text: oddOneOutText(listed) }] : []),
    ];
  });
}

export interface ColdChapterBeats {
  chapter: string;
  beats: PaceBeat[];
}

/** Chapters in the order the viewer first meets them. */
export function chaptersOf(beats: readonly PaceBeat[]): ColdChapterBeats[] {
  const byChapter = new Map<string, PaceBeat[]>();
  for (const beat of beats) byChapter.set(beat.chapter, [...(byChapter.get(beat.chapter) ?? []), beat]);
  return [...byChapter].map(([chapter, chapterBeats]) => ({ chapter, beats: chapterBeats }));
}

const seconds = (s: number): string => `${s.toFixed(1)} s`;

const spokenBeat = (beat: PaceBeat, startS: number): string =>
  [`[${beat.id}] from ${seconds(startS)}`, `spoken: ${beat.spoken}`, `beat ends at ${seconds(startS + beat.durationS)}`].join("\n");

/**
 * One chapter as it is heard: spoken words and each beat's end, on the chapter's clock. The screen is left out
 * (TP-3807): the reader-gap labels come from readers who had the narration only, and a card naming "Tick" beside
 * "burndown.json" let the viewer explain a word those readers could not.
 */
export function spokenTranscript(beats: readonly PaceBeat[]): string {
  let startS = 0;
  return beats
    .map((beat) => {
      const block = spokenBeat(beat, startS);
      startS += beat.durationS;
      return block;
    })
    .join("\n\n");
}

const AnswerSchema = z.strictObject({
  qid: z.string(),
  not_stated: z.boolean(),
  what: z.string(),
  what_quotes: z.array(EvidenceSchema),
  why: z.string(),
  why_quotes: z.array(EvidenceSchema),
  odd_one_out: z.string().nullable(),
});
type ColdAnswer = z.infer<typeof AnswerSchema>;
const ReplySchema = z.strictObject({ answers: z.array(AnswerSchema), summary: z.string() });
type ColdReply = JudgeReply<z.infer<typeof ReplySchema>>;

export interface ColdGrade {
  score: 0 | 1 | 2;
  void_reason: string | null;
}

/** 2 is what and why, 1 is what only; any quote missing from this chapter's spoken words voids the answer. */
export function scoreAnswer(answer: ColdAnswer, spokenTexts: ReadonlyMap<string, string>): ColdGrade {
  if (answer.not_stated) return { score: 0, void_reason: "not stated" };
  const what = voidReason(answer.what_quotes, spokenTexts);
  if (what) return { score: 0, void_reason: what };
  if (answer.why_quotes.length === 0) return { score: 1, void_reason: null };
  const why = voidReason(answer.why_quotes, spokenTexts);
  return why ? { score: 0, void_reason: why } : { score: 2, void_reason: null };
}

export const clampSummary = (summary: string): string =>
  summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_SUMMARY_LINES)
    .join("\n");

interface PosedQuestion {
  qid: string;
  text: string;
  question: ColdQuestion | null;
}

const canaryItem = (input: ColdInput, chapter: string): string =>
  `relay-${canonicalSha({ scriptSha: input.scriptSha, run: input.run, chapter }).slice(0, 6)}`;

/** The canary sits at a nonce-chosen place under an ordinary qid, so its position does not give it away. */
function poseQuestions(questions: readonly ColdQuestion[], canary: string, ask: (item: string) => string): PosedQuestion[] {
  const posed: Omit<PosedQuestion, "qid">[] = questions.map((question) => ({ text: question.text, question }));
  posed.splice(Number.parseInt(canary.slice(-6), 16) % (posed.length + 1), 0, { text: ask(canary), question: null });
  return posed.map((q, i) => ({ qid: `q${i + 1}`, ...q }));
}

function coldPrompt(rubric: string, chapter: ColdChapterBeats, summary: string, posed: readonly PosedQuestion[]): string {
  const memory = summary || "Nothing yet: this is the first chapter.";
  const questions = posed.map((q) => `- ${q.qid}: ${q.text}`).join("\n");
  return `${rubric}\n\n## What you remember so far\n\n${memory}\n\n## Chapter ${chapter.chapter}, played once\n\n${spokenTranscript(chapter.beats)}\n\n## Questions\n\n${questions}\n`;
}

export interface ColdInput {
  scriptSha: string;
  beats: readonly PaceBeat[];
  rubric: string;
  judge: JudgeConfig;
  harness: JudgeHarness;
  run: number;
  /**
   * The script's declared terms (`video.glossary` names); each is asked where it is first spoken, if no label shows it.
   */
  glossary?: readonly string[];
  /** The viewers' agreed undefined terms (`coldTerms`), asked like the glossary but counted in their own column. */
  viewerTerms?: readonly string[];
}

export interface ColdScore extends ColdGrade {
  qid: string;
  kind: ScoredKind;
  beat: string;
  item: string;
}

export interface OddOneOutPick {
  qid: string;
  beat: string;
  items: string[];
  picked: string | null;
}

export interface ColdChapter {
  chapter: string;
  minutes: number;
  summary: string;
  scores: ColdScore[];
  odd_one_out: OddOneOutPick[];
  undefined_items: number;
  undefined_per_minute: number;
  /** Viewer-term questions scored 0; kept out of `undefined_items` so its bars compare with runs before TP-3807. */
  undefined_terms: number;
  undefined_terms_per_minute: number;
  /** One a call: the item call's, then the spoken-term call's when the chapter speaks a term. */
  canaries: CanaryResult[];
}

export interface ColdResult {
  eval_version: string;
  judge: string;
  chapters: ColdChapter[];
  failures: string[];
  trusted: boolean;
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

// A list item no clause of its chapter glosses ("choose, make and prove") scores 0 whatever the viewer says. A judge
// asked "what is choose?" may credit the list's heading ("seven jobs") as a what in one run and call it not stated
// in the next; E9 saw that flip one chapter between 10.7 and 0 undefined items a minute. The heading says what
// kind of thing the item is, never what it is, so code decides and the judge's mood cannot move the score.
const BARE: ColdGrade = { score: 0, void_reason: "named only in a list" };

export const coldEvalVersion = (input: Pick<ColdInput, "rubric" | "judge">): string =>
  evalVersion(COLD_EVAL_ID, input.rubric, input.judge, {
    questions: [whatWhyText("<item>"), termText("<term>"), invariantText("<item>"), oddOneOutText(["<a>", "<b>", "<c>"])],
    canary: "relay-<nonce>",
    max_summary_lines: MAX_SUMMARY_LINES,
    odd_one_out_min_items: ODD_ONE_OUT_MIN_ITEMS,
    bare_list_item: BARE.void_reason,
    transcript: "spoken words and beat ends; no screen",
    spoken_terms: "glossary, identifiers and viewer-named terms, at first spoken use, unless a label shows them",
    viewer_term_zeros: "own column, not in undefined_items",
    spoken_rubric_sha: canonicalSha(readRubric(COLD_SPOKEN_RUBRIC)),
    viewer_terms: { rubric_sha: canonicalSha(readRubric(COLD_TERMS_RUBRIC)), runs: TERM_RUNS, quorum: TERM_QUORUM, fold: "case and plural" },
  });

const missing = (reply: ColdReply): ColdGrade => ({ score: 0, void_reason: reply.ok ? "not answered" : `call failed: ${reply.reason}` });

function pickOf(answer: ColdAnswer | undefined, items: readonly string[]): string | null {
  const key = answer?.odd_one_out?.trim().toLowerCase();
  return items.find((i) => i.trim().toLowerCase() === key) ?? null;
}

function canaryResult(canary: string, answer: ColdAnswer | undefined): CanaryResult {
  const got = answer ? (answer.not_stated ? "not_stated" : "answered") : "missing";
  return { canary, dim: "canary", got, pass: got === "not_stated" };
}

interface ChapterCall {
  canary: string;
  posed: readonly PosedQuestion[];
  reply: ColdReply;
}

interface GradedCall {
  scores: ColdScore[];
  oddOneOut: OddOneOutPick[];
  canary: CanaryResult;
}

function gradeCall(chapter: ColdChapterBeats, { canary, posed, reply }: ChapterCall): GradedCall {
  const answerOf = (qid: string) => (reply.ok ? reply.output.answers.find((a) => a.qid === qid) : undefined);
  const spoken = new Map(chapter.beats.map((b) => [b.id, b.spoken]));
  const bare = bareListItems(chapter.beats, ODD_ONE_OUT_MIN_ITEMS);
  const grade = (q: Extract<ColdQuestion, { item: string }>, answer: ColdAnswer | undefined): ColdGrade =>
    q.kind === "what-why" && bare.has(bareKey(q.beat, q.item)) ? BARE : answer ? scoreAnswer(answer, spoken) : missing(reply);
  const scores: ColdScore[] = [];
  const oddOneOut: OddOneOutPick[] = [];
  for (const { qid, question } of posed) {
    const answer = answerOf(qid);
    if (question?.kind === "odd-one-out") oddOneOut.push({ qid, beat: question.beat, items: question.items, picked: pickOf(answer, question.items) });
    else if (question) scores.push({ qid, kind: question.kind, beat: question.beat, item: question.item, ...grade(question, answer) });
  }
  return { scores, oddOneOut, canary: canaryResult(canary, answerOf(posed.find((q) => q.question === null)!.qid)) };
}

function gradeChapter(chapter: ColdChapterBeats, calls: readonly ChapterCall[], summary: string): ColdChapter {
  const graded = calls.map((call) => gradeCall(chapter, call));
  const scores = graded.flatMap((g) => g.scores);
  const minutes = chapter.beats.reduce((sum, b) => sum + b.durationS, 0) / 60;
  const undefinedItems = scores.filter((s) => s.kind !== "invariant" && s.kind !== "viewer-term" && s.score === 0).length;
  const undefinedTerms = scores.filter((s) => s.kind === "viewer-term" && s.score === 0).length;
  const perMinute = (n: number): number => (minutes > 0 ? n / minutes : 0);
  return {
    chapter: chapter.chapter,
    minutes,
    summary,
    scores,
    odd_one_out: graded.flatMap((g) => g.oddOneOut),
    undefined_items: undefinedItems,
    undefined_per_minute: perMinute(undefinedItems),
    undefined_terms: undefinedTerms,
    undefined_terms_per_minute: perMinute(undefinedTerms),
    canaries: graded.map((g) => g.canary),
  };
}

interface ChapterAsk {
  input: ColdInput;
  chapter: ColdChapterBeats;
  summary: string;
  questions: readonly ColdQuestion[];
}

/** One call: these questions, the chapter as heard, the summary so far, and a canary under its own nonce. */
async function askCall({ input, chapter, summary, questions }: ChapterAsk, rubric: string, nonce: string, ask: (item: string) => string): Promise<ChapterCall> {
  const canary = canaryItem(input, nonce);
  const posed = poseQuestions(questions, canary, ask);
  return { canary, posed, reply: await input.harness({ prompt: coldPrompt(rubric, chapter, summary, posed), schema: ReplySchema }) };
}

/** The item call always runs, since it carries the summary forward; the spoken-term call runs when a term is asked. */
async function askChapter(ask: ChapterAsk, spokenRubric: string): Promise<ChapterCall[]> {
  const ids = new Set(ask.chapter.beats.map((b) => b.id));
  const mine = ask.questions.filter((q) => ids.has(q.beat));
  const terms = mine.filter(isTerm);
  const items = await askCall({ ...ask, questions: mine.filter((q) => !isTerm(q)) }, ask.input.rubric, ask.chapter.chapter, whatWhyText);
  if (terms.length === 0) return [items];
  return [items, await askCall({ ...ask, questions: terms }, spokenRubric, `${ask.chapter.chapter}:terms`, termText)];
}

/**
 * One cold-viewer run: fresh calls per chapter in order. The viewer hears only that chapter's narration
 * and its own summary of the chapters before, the way a first viewer who cannot scroll back remembers them.
 */
export async function runCold(input: ColdInput): Promise<ColdResult> {
  const chapters: ColdChapter[] = [];
  const replies: ColdReply[] = [];
  const spokenRubric = readRubric(COLD_SPOKEN_RUBRIC);
  const questions = coldQuestions(input.beats, input.glossary, input.viewerTerms);
  let summary = "";
  for (const chapter of chaptersOf(input.beats)) {
    const calls = await askChapter({ input, chapter, summary, questions }, spokenRubric);
    replies.push(...calls.map((c) => c.reply));
    const items = calls[0]!.reply;
    if (items.ok) summary = clampSummary(items.output.summary);
    chapters.push(gradeChapter(chapter, calls, summary));
  }
  const failures = replies.flatMap((r) => (r.ok ? [] : [r.reason]));
  return {
    eval_version: coldEvalVersion(input),
    judge: judgeLabel(input.judge),
    chapters,
    failures,
    trusted: failures.length === 0 && chapters.every((c) => c.canaries.every((k) => k.pass)),
    spend: sumSpend(replies),
  };
}

/** Odd-one-out picks that at least `quorum` runs agree on, per beat; one run's pick is noise. */
export function agreedOddOnes(runs: readonly ColdResult[], quorum = 2): { beat: string; item: string }[] {
  const votes = new Map<string, Map<string, number>>();
  for (const { beat, picked } of runs.flatMap((r) => r.chapters.flatMap((c) => c.odd_one_out))) {
    if (picked === null) continue;
    const tally = votes.get(beat) ?? new Map<string, number>();
    votes.set(beat, tally.set(picked, (tally.get(picked) ?? 0) + 1));
  }
  return [...votes].flatMap(([beat, tally]) => [...tally].filter(([, n]) => n >= quorum).map(([item]) => ({ beat, item })));
}

const TermsSchema = z.strictObject({ terms: z.array(z.string()) });

export interface ColdTermsInput {
  beats: readonly PaceBeat[];
  /** The terms rubric, `l1-cold-terms.md`. */
  rubric: string;
  harness: JudgeHarness;
}

export interface ColdTerms {
  /** Terms at least `TERM_QUORUM` runs named, in the form the narration speaks first. */
  terms: string[];
  /** Each run's own list, empty for a failed call. */
  named: string[][];
  failures: string[];
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

const termsPrompt = (rubric: string, beats: readonly PaceBeat[]): string =>
  `${rubric}\n\n${chaptersOf(beats).map((c) => `## Chapter ${c.chapter}\n\n${spokenTranscript(c.beats)}`).join("\n\n")}\n`;

/**
 * Plain words a script gives its own meaning ("head", "grant") are jargon nothing in their spelling flags, so fresh
 * viewers of the whole video name the spoken terms they cannot define, and the ones a quorum agrees on are asked.
 */
export async function coldTerms(input: ColdTermsInput): Promise<ColdTerms> {
  const replies: JudgeReply<z.infer<typeof TermsSchema>>[] = [];
  for (let run = 0; run < TERM_RUNS; run++) replies.push(await input.harness({ prompt: termsPrompt(input.rubric, input.beats), schema: TermsSchema }));
  const named = replies.map((r) => (r.ok ? r.output.terms : []));
  return {
    terms: agreedTerms(named, input.beats, TERM_QUORUM),
    named,
    failures: replies.flatMap((r) => (r.ok ? [] : [r.reason])),
    spend: sumSpend(replies),
  };
}
