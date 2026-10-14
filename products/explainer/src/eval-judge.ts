import { z } from "zod";
import { canonicalSha } from "./eval-store.js";
import { EvidenceSchema, beatTexts, evalVersion, formatEvidence, renderBeat, voidReason, type Evidence } from "./eval-evidence.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import type { EvalBeat } from "./eval-view.js";

export const L1_EVAL_ID = "L1-judge";
export const BEAT_DIMS = ["B1", "B2", "B3", "B4", "B5", "B6"] as const;
export const SCRIPT_DIMS = ["J1", "J2", "J3", "J4", "J5", "J6", "J7"] as const;
export type BeatDim = (typeof BEAT_DIMS)[number];

/** A known-bad beat slipped into every judged batch; a judge that passes one is not trusted. */
export interface Canary {
  key: string;
  spoken: string;
  assertion: string;
  must_fail: BeatDim[];
}

export const L1_CANARIES: readonly Canary[] = [
  {
    key: "process-narration",
    spoken: "In our review we audited every claim and traced each call before we wrote this part of the tour.",
    assertion: "We checked the claims",
    must_fail: ["B5"],
  },
  {
    key: "master-key-filler",
    spoken: "Thought process: this part is important and worth understanding, so keep it in mind as we go.",
    assertion: "This part matters",
    must_fail: ["B1", "B6"],
  },
];

const BeatCallSchema = z.strictObject({
  beats: z.array(z.strictObject({ beat: z.string(), dims: z.array(z.strictObject({ dim: z.enum(BEAT_DIMS), evidence: z.array(EvidenceSchema), pass: z.boolean() })) })),
});
const ScriptCallSchema = z.strictObject({
  dims: z.array(z.strictObject({ dim: z.enum(SCRIPT_DIMS), evidence: z.array(EvidenceSchema), score: z.number().int().min(1).max(5) })),
});

export interface L1Rubrics {
  beat: string;
  script: string;
}

export interface L1Input {
  scriptSha: string;
  beats: readonly EvalBeat[];
  /** Beat ids in each chapter, in order; each chapter is one judged batch. */
  chapters: readonly (readonly string[])[];
  rubrics: L1Rubrics;
  judge: JudgeConfig;
  harness: JudgeHarness;
  run: number;
}

/** A verdict with its evidence, or void with the reason; a void verdict never counts. */
export interface Verdict {
  score: number | null;
  evidence: string;
  void_reason: string | null;
}

/** `got` is the canary verdict as the judge gave it; `pass` is whether that is the known-bad answer. */
export interface CanaryResult {
  canary: string;
  dim: string;
  got: string;
  pass: boolean;
}

export interface L1Result {
  eval_version: string;
  judge: string;
  beats: { beat: string; dim: BeatDim; verdict: Verdict }[];
  script: { dim: (typeof SCRIPT_DIMS)[number]; verdict: Verdict }[];
  canaries: CanaryResult[];
  failures: string[];
  trusted: boolean;
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

export const l1EvalVersion = (rubrics: L1Rubrics, judge: JudgeConfig): string =>
  evalVersion(L1_EVAL_ID, `${rubrics.beat}\n${rubrics.script}`, judge, L1_CANARIES);

function canaryBeat(canary: Canary, scriptSha: string, chapter: number): EvalBeat {
  const visual = { map_id: null, mode: "none" as const, you_are_here: null, nodes_shown: [], edges_shown: [], state_changes: [], labels: [], chips: [] };
  const id = `x${canonicalSha({ canary: canary.key, scriptSha, chapter }).slice(0, 6)}`;
  return { id, function: "WHAT", assertion: canary.assertion, why: undefined, spoken: canary.spoken, visual, facts: [] };
}

/**
 * Rotates canaries over chapters and runs. The canary goes last: B3 judges a beat against the one
 * before it, and a live run showed a canary placed mid-batch being cited for the next beat's B3.
 */
function withCanary(beats: EvalBeat[], scriptSha: string, chapter: number, run: number) {
  const canary = L1_CANARIES[(chapter + run) % L1_CANARIES.length]!;
  const beat = canaryBeat(canary, scriptSha, chapter);
  return { canary, beat, batch: [...beats, beat] };
}

const verdictOf = (evidence: readonly Evidence[], score: number, texts: ReadonlyMap<string, string>): Verdict => {
  const reason = voidReason(evidence, texts);
  return { score: reason ? null : score, evidence: formatEvidence(evidence), void_reason: reason };
};

const unjudged = (reason: string): Verdict => ({ score: null, evidence: "", void_reason: reason });

type BeatOutput = z.infer<typeof BeatCallSchema>;

function beatVerdicts(beats: readonly EvalBeat[], reply: JudgeReply<BeatOutput>, texts: ReadonlyMap<string, string>) {
  const byBeat = new Map(reply.ok ? reply.output.beats.map((b) => [b.beat, b.dims]) : []);
  return beats.flatMap((beat) =>
    BEAT_DIMS.map((dim) => {
      if (!reply.ok) return { beat: beat.id, dim, verdict: unjudged(`call failed: ${reply.reason}`) };
      const found = byBeat.get(beat.id)?.find((d) => d.dim === dim);
      return { beat: beat.id, dim, verdict: found ? verdictOf(found.evidence, found.pass ? 1 : 0, texts) : unjudged("not judged") };
    }),
  );
}

function canaryResults(canary: Canary, id: string, verdicts: ReturnType<typeof beatVerdicts>): CanaryResult[] {
  return canary.must_fail.map((dim) => {
    const verdict = verdicts.find((v) => v.beat === id && v.dim === dim)!.verdict;
    const got = verdict.score === null ? "void" : verdict.score === 0 ? "fail" : "pass";
    return { canary: canary.key, dim, got, pass: got === "fail" };
  });
}

const beatPrompt = (rubric: string, batch: readonly EvalBeat[]): string =>
  `${rubric}\n\n## Beats, in order\n\n${batch.map((b) => renderBeat(b, "SV", true)).join("\n\n")}\n`;

async function judgeChapter(input: L1Input, ids: readonly string[], chapter: number) {
  const beats = ids.map((id) => input.beats.find((b) => b.id === id)!);
  const { canary, beat, batch } = withCanary(beats, input.scriptSha, chapter, input.run);
  const reply = await input.harness({ prompt: beatPrompt(input.rubrics.beat, batch), schema: BeatCallSchema });
  const verdicts = beatVerdicts(batch, reply, beatTexts(batch, "SV"));
  return { reply, verdicts: verdicts.filter((v) => v.beat !== beat.id), canaries: canaryResults(canary, beat.id, verdicts) };
}

async function judgeScript(input: L1Input) {
  const prompt = beatPrompt(input.rubrics.script, input.beats);
  const reply = await input.harness({ prompt, schema: ScriptCallSchema });
  const texts = beatTexts(input.beats, "SV");
  const verdicts = SCRIPT_DIMS.map((dim) => {
    if (!reply.ok) return { dim, verdict: unjudged(`call failed: ${reply.reason}`) };
    const found = reply.output.dims.find((d) => d.dim === dim);
    return { dim, verdict: found ? verdictOf(found.evidence, found.score, texts) : unjudged("not judged") };
  });
  return { reply, verdicts };
}

export const sumSpend = (replies: readonly JudgeReply<unknown>[]) => ({
  usd: replies.reduce((sum, r) => sum + r.usd, 0),
  tokensIn: replies.reduce((sum, r) => sum + r.tokensIn, 0),
  tokensOut: replies.reduce((sum, r) => sum + r.tokensOut, 0),
});

/**
 * One L1 run: a beat call per chapter, each with a canary hidden in it, then one script call.
 * A run whose canary is not failed with evidence, or whose call failed, is not trusted.
 */
export async function runL1(input: L1Input): Promise<L1Result> {
  const chapters = [];
  for (const [i, ids] of input.chapters.entries()) chapters.push(await judgeChapter(input, ids, i));
  const script = await judgeScript(input);
  const replies = [...chapters.map((c) => c.reply), script.reply];
  const canaries = chapters.flatMap((c) => c.canaries);
  const failures = replies.flatMap((r) => (r.ok ? [] : [r.reason]));
  return {
    eval_version: l1EvalVersion(input.rubrics, input.judge),
    judge: judgeLabel(input.judge),
    beats: chapters.flatMap((c) => c.verdicts),
    script: script.verdicts,
    canaries,
    failures,
    trusted: failures.length === 0 && canaries.every((c) => c.pass),
    spend: sumSpend(replies),
  };
}
