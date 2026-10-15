import { z } from "zod";
import { canonicalSha } from "./eval-store.js";
import { EvidenceSchema, evalVersion, voidReason } from "./eval-evidence.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sumSpend, type CanaryResult } from "./eval-judge.js";
import type { PaceBeat } from "./pace-items.js";

export const COLD_EVAL_ID = "L1-cold";
/** The viewer's whole memory of earlier chapters; anything longer would let the transcript leak forward. */
export const MAX_SUMMARY_LINES = 3;
/** A list this long is where a different kind of thing can hide among its neighbours. */
export const ODD_ONE_OUT_MIN_ITEMS = 3;

export type ColdQuestion =
  | { kind: "what-why" | "invariant"; beat: string; item: string; text: string }
  | { kind: "odd-one-out"; beat: string; items: string[]; text: string };

const whatWhyText = (item: string): string => `What is "${item}", and why is it there?`;
const invariantText = (item: string): string => `"${item}" must always hold. What keeps it, or how does it break today?`;
const oddOneOutText = (items: readonly string[]): string =>
  `Of ${items.map((i) => `"${i}"`).join(", ")}: which item is a different kind of thing, if any?`;

const itemLabels = (beat: PaceBeat): string[] => beat.items.filter((i) => i.role === "item").map((i) => i.label);

/** Every question comes from the item track, so a script cannot pass on questions written to suit it. */
export function coldQuestions(beats: readonly PaceBeat[]): ColdQuestion[] {
  return beats.flatMap((beat): ColdQuestion[] => {
    const listed = itemLabels(beat);
    return [
      ...beat.newItems.map((i) => ({ kind: "what-why" as const, beat: beat.id, item: i.label, text: whatWhyText(i.label) })),
      ...beat.newItems.filter((i) => i.kind === "inv").map((i) => ({ kind: "invariant" as const, beat: beat.id, item: i.label, text: invariantText(i.label) })),
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

function playbackBeat(beat: PaceBeat, startS: number): string {
  const shown = beat.items.map((i) => `\`${i.label}\` from ${seconds(startS + (i.atS ?? 0))}`);
  return [
    `[${beat.id}] from ${seconds(startS)}`,
    `spoken: ${beat.spoken}`,
    ...(shown.length > 0 ? [`on screen: ${shown.join("; ")}`] : []),
    `beat ends at ${seconds(startS + beat.durationS)}`,
  ].join("\n");
}

/** One chapter as it plays: spoken words, each label's exposure second, each beat's end, on the chapter's clock. */
export function playbackTranscript(beats: readonly PaceBeat[]): string {
  let startS = 0;
  return beats
    .map((beat) => {
      const block = playbackBeat(beat, startS);
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
function poseQuestions(questions: readonly ColdQuestion[], canary: string): PosedQuestion[] {
  const posed: Omit<PosedQuestion, "qid">[] = questions.map((question) => ({ text: question.text, question }));
  posed.splice(Number.parseInt(canary.slice(-6), 16) % (posed.length + 1), 0, { text: whatWhyText(canary), question: null });
  return posed.map((q, i) => ({ qid: `q${i + 1}`, ...q }));
}

function coldPrompt(rubric: string, chapter: ColdChapterBeats, summary: string, posed: readonly PosedQuestion[]): string {
  const memory = summary || "Nothing yet: this is the first chapter.";
  const questions = posed.map((q) => `- ${q.qid}: ${q.text}`).join("\n");
  return `${rubric}\n\n## What you remember so far\n\n${memory}\n\n## Chapter ${chapter.chapter}, played once\n\n${playbackTranscript(chapter.beats)}\n\n## Questions\n\n${questions}\n`;
}

export interface ColdInput {
  scriptSha: string;
  beats: readonly PaceBeat[];
  rubric: string;
  judge: JudgeConfig;
  harness: JudgeHarness;
  run: number;
}

export interface ColdScore extends ColdGrade {
  qid: string;
  kind: "what-why" | "invariant";
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
  canary: CanaryResult;
}

export interface ColdResult {
  eval_version: string;
  judge: string;
  chapters: ColdChapter[];
  failures: string[];
  trusted: boolean;
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

export const coldEvalVersion = (input: Pick<ColdInput, "rubric" | "judge">): string =>
  evalVersion(COLD_EVAL_ID, input.rubric, input.judge, {
    questions: [whatWhyText("<item>"), invariantText("<item>"), oddOneOutText(["<a>", "<b>", "<c>"])],
    canary: "relay-<nonce>",
    max_summary_lines: MAX_SUMMARY_LINES,
    odd_one_out_min_items: ODD_ONE_OUT_MIN_ITEMS,
  });

const missing = (reply: ColdReply): ColdGrade => ({ score: 0, void_reason: reply.ok ? "not answered" : `call failed: ${reply.reason}` });

function pickOf(answer: ColdAnswer | undefined, items: readonly string[]): string | null {
  const key = answer?.odd_one_out?.trim().toLowerCase();
  return items.find((i) => i.trim().toLowerCase() === key) ?? null;
}

function canaryResult(chapter: string, answer: ColdAnswer | undefined): CanaryResult {
  const got = answer ? (answer.not_stated ? "not_stated" : "answered") : "missing";
  return { canary: `unknown-item-${chapter}`, dim: "canary", got, pass: got === "not_stated" };
}

function gradeChapter(chapter: ColdChapterBeats, posed: readonly PosedQuestion[], reply: ColdReply, summary: string): ColdChapter {
  const answerOf = (qid: string) => (reply.ok ? reply.output.answers.find((a) => a.qid === qid) : undefined);
  const spoken = new Map(chapter.beats.map((b) => [b.id, b.spoken]));
  const scores: ColdScore[] = [];
  const oddOneOut: OddOneOutPick[] = [];
  for (const { qid, question } of posed) {
    const answer = answerOf(qid);
    if (question?.kind === "odd-one-out") oddOneOut.push({ qid, beat: question.beat, items: question.items, picked: pickOf(answer, question.items) });
    else if (question) scores.push({ qid, kind: question.kind, beat: question.beat, item: question.item, ...(answer ? scoreAnswer(answer, spoken) : missing(reply)) });
  }
  const canary = canaryResult(chapter.chapter, answerOf(posed.find((q) => q.question === null)!.qid));
  const minutes = chapter.beats.reduce((sum, b) => sum + b.durationS, 0) / 60;
  const undefinedItems = scores.filter((s) => s.kind === "what-why" && s.score === 0).length;
  return { chapter: chapter.chapter, minutes, summary, scores, odd_one_out: oddOneOut, undefined_items: undefinedItems, undefined_per_minute: minutes > 0 ? undefinedItems / minutes : 0, canary };
}

/**
 * One cold-viewer run: a fresh call per chapter in order. The viewer sees only that chapter's playback
 * and its own summary of the chapters before, the way a first viewer who cannot scroll back remembers them.
 */
export async function runCold(input: ColdInput): Promise<ColdResult> {
  const chapters: ColdChapter[] = [];
  const replies: ColdReply[] = [];
  let summary = "";
  for (const chapter of chaptersOf(input.beats)) {
    const posed = poseQuestions(coldQuestions(chapter.beats), canaryItem(input, chapter.chapter));
    const reply = await input.harness({ prompt: coldPrompt(input.rubric, chapter, summary, posed), schema: ReplySchema });
    replies.push(reply);
    if (reply.ok) summary = clampSummary(reply.output.summary);
    chapters.push(gradeChapter(chapter, posed, reply, summary));
  }
  const failures = replies.flatMap((r) => (r.ok ? [] : [r.reason]));
  return {
    eval_version: coldEvalVersion(input),
    judge: judgeLabel(input.judge),
    chapters,
    failures,
    trusted: failures.length === 0 && chapters.every((c) => c.canary.pass),
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
