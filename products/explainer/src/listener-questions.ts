import { z } from "zod";
import { chaptersOf } from "./eval-cold.js";
import { evalVersion } from "./eval-evidence.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sumSpend } from "./eval-judge.js";
import type { PaceBeat } from "./pace-items.js";

export const LISTENER_EVAL_ID = "L1-listener";
/** A list read out across this many sentences makes the listener hold its first items while the next sentence starts. */
export const LIST_SPREAD_MIN_SENTENCES = 2;
/** "Then seal." is a fragment on its length alone; the listener names the longer ones. */
export const FRAGMENT_MAX_WORDS = 3;

// The owner's exercise (TP-4080): one paragraph, heard once, and every question it raises. The chapter is played with
// nothing before it, as in the hand run the fixture-v4 baseline comes from.
export const LISTENER_PROMPT = `You are hearing one chapter of a narrated explainer video, played once. You have heard nothing before it, you cannot replay it, and there is no screen.

List every question the chapter raises in your mind and leaves unanswered: a word or name it uses before saying what it is, a vague phrase ("keep what going?"), a step or link it skips, a claim with no reason, a count that does not add up. One question for each thing you cannot work out; do not merge two into one and do not pad. Tag each question with the id of the sentence that raised it. When a question asks what a term means, put the term in \`term\` exactly as spoken; otherwise \`term\` is null.

Also give every list the chapter reads out, with its items and the ids of the sentences its items fall in, and the ids of the sentences that are fragments rather than whole sentences.

Reply with JSON only.`;

const SENTENCE = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g;

export const ListenerReplySchema = z.strictObject({
  questions: z.array(z.strictObject({ sentence: z.string(), question: z.string(), term: z.string().nullable() })),
  lists: z.array(z.strictObject({ items: z.array(z.string()), sentences: z.array(z.string()) })),
  fragments: z.array(z.string()),
});
export type ListenerReply = z.infer<typeof ListenerReplySchema>;

const SentenceSchema = z.object({ id: z.string(), beat: z.string(), text: z.string() });
export type ListenerSentence = z.infer<typeof SentenceSchema>;

export const ListenerChapterSchema = z.object({
  chapter: z.string(),
  sentences: z.array(SentenceSchema.extend({ questions: z.number().int().nonnegative() })),
  questions: z.number().int().nonnegative(),
  /** Questions per sentence. */
  density: z.number().nonnegative(),
  /** Questions naming no sentence of this chapter; kept out of the counts. */
  untagged: z.number().int().nonnegative(),
  asked: ListenerReplySchema.shape.questions,
  flags: z.object({
    list_spread: z.array(z.object({ items: z.array(z.string()), sentences: z.array(z.string()) })),
    terms_before_setup: z.array(z.object({ term: z.string(), sentence: z.string() })),
    fragments: z.array(z.string()),
  }),
  failure: z.string().nullable(),
});
export type ListenerChapter = z.infer<typeof ListenerChapterSchema>;

export const ListenerResultSchema = z.object({
  eval_version: z.string(),
  judge: z.string(),
  chapters: z.array(ListenerChapterSchema),
  questions: z.number().int().nonnegative(),
  sentences: z.number().int().nonnegative(),
  density: z.number().nonnegative(),
  failures: z.array(z.string()),
  spend: z.object({ usd: z.number(), tokensIn: z.number(), tokensOut: z.number() }),
});
export type ListenerResult = z.infer<typeof ListenerResultSchema>;

/** A chapter's spoken words as the sentences a listener hears, numbered S1 on across its beats; none crosses a beat. */
export function chapterSentences(beats: readonly PaceBeat[]): ListenerSentence[] {
  const texts = beats.flatMap((beat) => (beat.spoken.match(SENTENCE) ?? []).map((text) => ({ beat: beat.id, text: text.trim() })));
  return texts.filter((s) => s.text.length > 0).map((s, i) => ({ id: `S${i + 1}`, ...s }));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const speaks = (sentence: ListenerSentence, term: string): boolean => new RegExp(`(?<!\\w)${escape(term.trim())}(?!\\w)`, "i").test(sentence.text);

/** Each asked term once, at the first sentence that speaks it; a term the chapter never speaks is the listener's own. */
function termsBeforeSetup(sentences: readonly ListenerSentence[], asked: ListenerReply["questions"]): ListenerChapter["flags"]["terms_before_setup"] {
  const seen = new Set<string>();
  const flags: ListenerChapter["flags"]["terms_before_setup"] = [];
  for (const { term } of asked) {
    if (term === null || seen.has(term.trim().toLowerCase())) continue;
    const first = sentences.find((s) => speaks(s, term));
    if (!first) continue;
    seen.add(term.trim().toLowerCase());
    flags.push({ term, sentence: first.id });
  }
  return flags;
}

const inOrder = (sentences: readonly ListenerSentence[], ids: Iterable<string>): string[] => {
  const wanted = new Set(ids);
  return sentences.filter((s) => wanted.has(s.id)).map((s) => s.id);
};

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => /\w/.test(w)).length;

function flagsOf(sentences: readonly ListenerSentence[], reply: ListenerReply): ListenerChapter["flags"] {
  const lists = reply.lists.map((list) => ({ items: list.items, sentences: inOrder(sentences, list.sentences) }));
  const short = sentences.filter((s) => wordCount(s.text) <= FRAGMENT_MAX_WORDS).map((s) => s.id);
  return {
    list_spread: lists.filter((list) => list.sentences.length >= LIST_SPREAD_MIN_SENTENCES),
    terms_before_setup: termsBeforeSetup(sentences, reply.questions),
    fragments: inOrder(sentences, [...reply.fragments, ...short]),
  };
}

/** One chapter's counts and flags from the listener's reply; code, not the listener, decides what each flag needs. */
export function tallyChapter(chapter: string, sentences: readonly ListenerSentence[], reply: ListenerReply, failure: string | null = null): ListenerChapter {
  const counts = new Map(sentences.map((s) => [s.id, 0]));
  for (const q of reply.questions) if (counts.has(q.sentence)) counts.set(q.sentence, counts.get(q.sentence)! + 1);
  const questions = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return {
    chapter,
    sentences: sentences.map((s) => ({ ...s, questions: counts.get(s.id)! })),
    questions,
    density: sentences.length > 0 ? questions / sentences.length : 0,
    untagged: reply.questions.length - questions,
    asked: reply.questions,
    flags: flagsOf(sentences, reply),
    failure,
  };
}

const NO_REPLY: ListenerReply = { questions: [], lists: [], fragments: [] };

const listenerPrompt = (sentences: readonly ListenerSentence[]): string =>
  `${LISTENER_PROMPT}\n\n## The chapter, played once\n\n${sentences.map((s) => `[${s.id}] ${s.text}`).join("\n")}\n`;

export const listenerEvalVersion = (judge: JudgeConfig): string =>
  evalVersion(LISTENER_EVAL_ID, LISTENER_PROMPT, judge, { split: SENTENCE.source, list_spread_min_sentences: LIST_SPREAD_MIN_SENTENCES, fragment_max_words: FRAGMENT_MAX_WORDS, memory: "none" });

export interface ListenerInput {
  beats: readonly PaceBeat[];
  judge: JudgeConfig;
  harness: JudgeHarness;
}

/** One fresh listener call per chapter, in order; a failed call leaves that chapter unscored and the run's failures say so. */
export async function runListener(input: ListenerInput): Promise<ListenerResult> {
  const replies: JudgeReply<ListenerReply>[] = [];
  const chapters: ListenerChapter[] = [];
  for (const { chapter, beats } of chaptersOf(input.beats)) {
    const sentences = chapterSentences(beats);
    const reply = await input.harness({ prompt: listenerPrompt(sentences), schema: ListenerReplySchema });
    replies.push(reply);
    chapters.push(reply.ok ? tallyChapter(chapter, sentences, reply.output) : tallyChapter(chapter, sentences, NO_REPLY, reply.reason));
  }
  const questions = chapters.reduce((sum, c) => sum + c.questions, 0);
  const sentences = chapters.reduce((sum, c) => sum + c.sentences.length, 0);
  return {
    eval_version: listenerEvalVersion(input.judge),
    judge: judgeLabel(input.judge),
    chapters,
    questions,
    sentences,
    density: sentences > 0 ? questions / sentences : 0,
    failures: chapters.flatMap((c) => (c.failure === null ? [] : [`${c.chapter}: ${c.failure}`])),
    spend: sumSpend(replies),
  };
}

const flagCounts = (chapters: readonly ListenerChapter[]): string => {
  const total = (pick: (c: ListenerChapter) => readonly unknown[]) => chapters.reduce((sum, c) => sum + pick(c).length, 0);
  return `${total((c) => c.flags.list_spread)} list-spread, ${total((c) => c.flags.terms_before_setup)} term-before-setup, ${total((c) => c.flags.fragments)} fragment`;
};

/**
 * Reported, never a gate. With no threshold it passes on any density; with one, a chapter asking more questions a
 * sentence than the threshold fails it. An unscored chapter fails it either way, since its zero would read as clean.
 */
export function listenerVerdict(result: Pick<ListenerResult, "chapters" | "questions" | "sentences" | "density" | "failures">, threshold?: number): { pass: boolean; detail: string } {
  const perChapter = result.chapters.map((c) => `${c.chapter} ${c.questions}/${c.sentences.length}`).join(", ");
  const head = `${result.questions} questions over ${result.sentences} sentences (${result.density.toFixed(2)} a sentence); ${perChapter}; flags: ${flagCounts(result.chapters)}`;
  if (result.failures.length > 0) return { pass: false, detail: `${head}; not scored: ${result.failures.join(", ")}` };
  const over = threshold === undefined ? [] : result.chapters.filter((c) => c.density > threshold);
  return { pass: over.length === 0, detail: over.length === 0 ? head : `${head}; over ${threshold} a sentence: ${over.map((c) => c.chapter).join(", ")}` };
}
