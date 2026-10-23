import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import type { ListenerReply } from "./listener-questions.js";
import type { PaceBeat } from "./pace-items.js";

/** A synthetic parcel desk; nothing here quotes a real video. */
export const beat = (id: string, chapter: string, spoken: string): PaceBeat => ({
  id, chapter, fn: "WHAT", spoken, durationS: 5, timed: false, items: [], newItems: [], mapBeside: false,
});

export const deskBeats = (): PaceBeat[] => [
  beat("c1-1", "c1", "Every parcel passes one desk. The desk keeps a ledger."),
  beat("c2-1", "c2", "Four checks come first: weigh, scan and label. Then seal."),
  beat("c2-2", "c2", "The courier signs the manifest before the van leaves."),
];

/** The `[S<n>] text` lines a listener prompt plays, by id. */
export const promptSentences = (prompt: string): Map<string, string> =>
  new Map([...prompt.matchAll(/^\[(S\d+)\] (.*)$/gm)].map((m) => [m[1]!, m[2]!]));

/** A listener stand-in: `answer` sees the chapter's sentences and returns its reply, at a fixed price per call. */
export function fakeListener(answer: (sentences: Map<string, string>) => ListenerReply | string) {
  const prompts: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    prompts.push(prompt);
    const reply = answer(promptSentences(prompt));
    if (typeof reply === "string") return { ok: false, reason: reply, usd: 0.001, tokensIn: 50, tokensOut: 0 };
    return { ok: true, output: schema.parse(reply), usd: 0.02, tokensIn: 400, tokensOut: 150 };
  };
  return { harness, prompts };
}

export const ask = (sentence: string, question: string, term: string | null = null) => ({ sentence, question, term });
export const quiet = (): ListenerReply => ({ questions: [], lists: [], fragments: [] });
