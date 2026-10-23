import { COLD_RUBRIC_DIMS, readColdRubric, type ColdRubricDim, type RubricBeat } from "./eval-cold-rubric.js";
import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";

/** Synthetic parcel-desk beats with none of the planted defects below; nothing here quotes a real video. */
export const cleanBeats = (): RubricBeat[] => [
  { id: "c1-1", spoken: "A courier prints a label for a parcel that does not exist.", screen: ["ghost label"] },
  { id: "c2-1", spoken: "Every scan passes one desk server before it reaches the ledger.", screen: ["desk server", "ledger"] },
  { id: "c2-2", spoken: "The desk server refuses a label whose parcel was never scanned.", screen: ["refused label"] },
];

interface Video {
  name: string;
  beats: RubricBeat[];
}

/** The `### Video X` sections of a rubric prompt, with each beat's spoken line and screen text. */
export function promptVideos(prompt: string): Video[] {
  return prompt
    .split("### Video ")
    .slice(1)
    .map((section) => ({
      name: section.slice(0, 1),
      beats: [...section.matchAll(/^\[([^\]]+)\]\nspoken: (.*)(?:\nscreen: (.*))?$/gm)].map((m) => ({ id: m[1]!, spoken: m[2]!, screen: m[3]?.split("; ") ?? [] })),
    }));
}

/** Earlier hooks the prompt lists, so the novelty row can see a repeat of the series. */
const seriesHooks = (prompt: string): string[] => [...prompt.matchAll(/^ {3}hook: (.*)$/gm)].map((m) => m[1]!);

const spoken = (beats: readonly RubricBeat[]) => beats.map((b) => b.spoken).join(" ");

/** Each row's planted defect, as a deterministic stand-in for a judge noticing it. */
const DEFECTS: Record<ColdRubricDim, (beats: readonly RubricBeat[], hooks: readonly string[]) => boolean> = {
  J8: (beats) => !/\b(does not exist|cost|lose|fails?|never|wrong)\b/i.test(beats[0]?.spoken ?? ""),
  J9: (beats) => (spoken(beats).match(/\b[A-Z]{2,}\b/g) ?? []).length >= 2,
  J10: (beats, hooks) => /\b(open source|is popular|package manager)\b/i.test(spoken(beats)) || beats.some((b) => hooks.includes(b.spoken)),
  J11: (beats) => /\b(various|in general|many ways|everything)\b/i.test(spoken(beats)),
  J12: (beats) => beats.flatMap((b) => b.screen).filter((s) => /stock photo|meme|plain bullet/.test(s)).length >= 2,
};

const quoteOf = (beat: RubricBeat) => ({ beat: beat.id, quote: beat.spoken.split(" ").slice(0, 3).join(" ") });

/**
 * A judge that scores a row 1 when its defect is planted and `score` otherwise, quoting each video's first beat.
 * `lenient` sees no defect, so it misses every canary; `evidence: "invented"` quotes words no beat holds.
 */
export function fakeRubricJudge(options: { score?: number; lenient?: boolean; evidence?: "quoted" | "invented" } = {}) {
  const calls: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    calls.push(prompt);
    const hooks = seriesHooks(prompt);
    const videos = promptVideos(prompt).map(({ name, beats }) => {
      const evidence = [options.evidence === "invented" ? { beat: beats[0]!.id, quote: "a sentence nobody wrote" } : quoteOf(beats[0]!)];
      const scoreOf = (dim: ColdRubricDim) => (!options.lenient && DEFECTS[dim](beats, hooks) ? 1 : (options.score ?? 4));
      return { video: name, dims: COLD_RUBRIC_DIMS.map((dim) => ({ dim, evidence, score: scoreOf(dim) })) };
    });
    return { ok: true, output: schema.parse({ videos }), usd: 0.01, tokensIn: 300, tokensOut: 80 };
  };
  return { harness, calls };
}

/** Sends rubric prompts to `rubric` and every other prompt to `other`, for tests whose harness serves several calls. */
export function routeRubric(rubric: JudgeHarness, other: JudgeHarness): JudgeHarness {
  const head = readColdRubric().trim();
  return (call) => (call.prompt.startsWith(head) ? rubric(call) : other(call));
}
