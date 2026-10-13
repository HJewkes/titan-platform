import type { JudgeCall, JudgeConfig, JudgeHarness, JudgeReply } from "./eval-harness.js";
import { BEAT_DIMS, L1_CANARIES, SCRIPT_DIMS } from "./eval-judge.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

export const sonnet: JudgeConfig = { provider: "claude-print", model: "sonnet", max_budget_usd: 0.5, wall_time_s: 600 };

const beat = (id: string, chapter: string, spoken: string, assertion: string) => ({
  id,
  chapter,
  function: "WHAT",
  mode: "explain",
  plannedS: 8,
  spoken,
  fact_ids: ["F1"],
  visual: { assertion, job: "numbers" },
});

/** Two chapters of an invented parcel desk, three beats in all. */
export const twoChapters = scriptWith({}, {
  chapters: [
    { id: "ch1", label: "Why", question: "Why refuse a label?" },
    { id: "ch2", label: "How", question: "Which part decides?" },
  ],
  beats: [
    beat("c1-1", "ch1", "A courier prints a label for a parcel that does not exist.", "Ghost labels cost a courier a day"),
    beat("c2-1", "ch2", "Every scan passes one desk server before it reaches the ledger.", "One server sits before the ledger"),
    beat("c2-2", "ch2", "The desk server refuses a label whose parcel was never scanned.", "Unscanned parcels get no label"),
  ],
});

/** The beats a prompt lists, as `[id]` headers followed by their spoken line. */
export function promptBeats(prompt: string): { id: string; spoken: string; headline: string }[] {
  const blocks = prompt.split("\n\n").filter((block) => block.startsWith("["));
  return blocks.map((block) => {
    const id = /^\[([^\]]+)\]/.exec(block)![1]!;
    const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1] ?? "";
    return { id, spoken: field("spoken"), headline: field("headline") };
  });
}

const quoteOf = (text: string): string => text.split(" ").slice(0, 3).join(" ");
const isCanary = (spoken: string) => L1_CANARIES.some((c) => c.spoken === spoken);

/** A careful judge: quotes each beat, fails canaries, passes every real beat. `lenient` passes canaries too. */
export function fakeJudge(options: { lenient?: boolean; evidence?: "quoted" | "none" | "invented" } = {}) {
  const calls: string[] = [];
  const evidenceFor = (id: string, text: string) =>
    options.evidence === "none" ? [] : [{ beat: id, quote: options.evidence === "invented" ? "a sentence nobody wrote" : quoteOf(text) }];
  const harness: JudgeHarness = async <T>({ prompt }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    const beats = promptBeats(prompt);
    const output = prompt.includes("# L1 script rubric")
      ? { dims: SCRIPT_DIMS.map((dim) => ({ dim, evidence: evidenceFor(beats[0]!.id, beats[0]!.spoken), score: 4 })) }
      : { beats: beats.map((b) => ({ beat: b.id, dims: BEAT_DIMS.map((dim) => ({ dim, evidence: evidenceFor(b.id, b.spoken), pass: options.lenient || !isCanary(b.spoken) })) })) };
    return { ok: true, output: output as T, usd: 0.01, tokensIn: 100, tokensOut: 20 };
  };
  return { harness, calls };
}

/** A viewer that cites the first beat for every answer; `answerCanary` makes it guess the unanswerable one. */
export function fakeViewer(answers: Record<string, string>, options: { answerCanary?: boolean; cite?: "spoken" | "none" } = {}) {
  const calls: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    const first = promptBeats(prompt)[0]!;
    const text = first.spoken || first.headline;
    const citations = options.cite === "none" ? [] : [{ beat: first.id, quote: quoteOf(options.cite === "spoken" ? first.spoken || "spoken words" : text) }];
    const qids = [...prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1]!);
    const output = {
      answers: qids.map((qid) =>
        qid === "canary"
          ? { qid, citations: options.answerCanary ? citations : [], not_stated: !options.answerCanary, answer: options.answerCanary ? "It routes scans." : "" }
          : { qid, citations, not_stated: false, answer: answers[qid] ?? "" },
      ),
    };
    return { ok: true, output: output as T, usd: 0.02, tokensIn: 300, tokensOut: 60 };
  };
  return { harness, calls };
}
