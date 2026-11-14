import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import type { WritingJudgeConfig, WritingJudgeResult, WritingRubrics } from "./writing-judge.js";

export const CONFIG: WritingJudgeConfig = { provider: "claude-print", model: "judge-model", extractor_model: "extractor-model", max_budget_usd: 0.5, wall_time_s: 60 };
export const RUBRICS: WritingRubrics = {
  judge: "JUDGE\n{{checklist}}\n{{piece}}",
  checklist: JSON.stringify([{ id: "naming_refrain", question: "Q1" }, { id: "staccato_drama", question: "Q2" }]),
  extract: "EXTRACT\n{{piece}}",
};
/** A line of the canary paragraph the judge sees after every piece. */
export const CANARY_LINE = "That is called the cassette.";
export const FILLER = "The pump sends warm water through the copper pipe today.";

type Mark = { id: string; quote: string; why: string };
type Term ={ term: string; first_mention: string; definition: string | null; motivation: string | null; used_after: boolean };

const reply = <T,>(call: JudgeCall<T>, output: unknown): JudgeReply<T> => ({ ok: true, output: call.schema.parse(output), usd: 0.1, tokensIn: 10, tokensOut: 5 });

/** Answers the judge call with `marks` and the extractor call with `terms`; either may be a failed call. */
export function fakeHarness(marks: Mark[] | "fail", terms: Term[] | "fail" = []): () => JudgeHarness {
  const answer = <T,>(call: JudgeCall<T>): JudgeReply<T> => {
    const output = call.prompt.startsWith("JUDGE") ? marks : terms;
    if (output === "fail") return { ok: false, reason: "auth_misconfigured: not logged in", usd: 0, tokensIn: 0, tokensOut: 0 };
    return reply(call, call.prompt.startsWith("JUDGE") ? { marks: output } : { terms: output });
  };
  return () => async <T,>(call: JudgeCall<T>) => answer(call);
}

export const mark = (quote: string, id = "naming_refrain"): Mark => ({ id, quote, why: "nothing lost" });
export const term = (name: string): Term => ({ term: name, first_mention: `The ${name} moves.`, definition: null, motivation: null, used_after: true });
export const termName = (i: number): string => `valve${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
/** One mark on each of the first `n` term sentences, so each is a distinct passage. */
export const termQuotes = (n: number): Mark[] => Array.from({ length: n }, (_, i) => mark(`The ${termName(i)} sends warm water`));

/** `sentences` ten-word sentences, ten per beat; the first `termCount` each name one invented term. */
export function beatsOf(sentences: number, termCount = 0): { id: string; spoken: string }[] {
  const lines = Array.from({ length: sentences }, (_, i) => (i < termCount ? `The ${termName(i)} sends warm water through the copper pipe today.` : FILLER));
  return Array.from({ length: Math.ceil(sentences / 10) }, (_, b) => ({ id: `b${b + 1}`, spoken: lines.slice(b * 10, b * 10 + 10).join(" ") }));
}

export const judgedRow = (result: WritingJudgeResult, id: string) => result.rows.find((r) => r.id === id)!;
