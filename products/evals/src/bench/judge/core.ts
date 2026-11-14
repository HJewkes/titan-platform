import { realpathSync } from "node:fs";
import { runAgent } from "@titan-design/agent";
import { quoteInText } from "@titan-design/evidence";
import { z, type ZodType } from "zod";
import type { Arm } from "../arms.js";
import { transcriptPath } from "../job.js";
import { meterJob } from "../meter.js";

export interface JudgeSpec {
  model: string;
  effort: Arm["effort"];
}

export interface JudgeChoice {
  judge: JudgeSpec;
  second: JudgeSpec;
}

const SONNET_HIGH: JudgeSpec = { model: "claude-sonnet-5-5", effort: "high" };
const OPUS_MED: JudgeSpec = { model: "claude-opus-5-5", effort: "medium" };
const FABLE_MED: JudgeSpec = { model: "claude-fable-5-2", effort: "medium" };
const HAIKU_HIGH: JudgeSpec = { model: "claude-haiku-5-5", effort: "high" };

/** Design section 5, in preference order: a pair of arms (P) or one arm's output (R false alarm). */
const PREFERENCE = {
  pair: { judge: [SONNET_HIGH, FABLE_MED], second: [FABLE_MED, HAIKU_HIGH] },
  single: { judge: [SONNET_HIGH, OPUS_MED], second: [FABLE_MED, OPUS_MED] },
} as const;

function firstFree(candidates: readonly JudgeSpec[], taken: ReadonlySet<string>): JudgeSpec {
  const found = candidates.find((candidate) => !taken.has(candidate.model));
  if (found === undefined) throw new Error(`no judge model is free of ${[...taken].join(", ")}`);
  return found;
}

/** A judge never shares a model with an arm it judges, and the second judge differs from both arms and the first. */
export function pickJudges(armModels: readonly string[]): JudgeChoice {
  if (armModels.length < 1 || armModels.length > 2) throw new Error(`judging takes one or two arm outputs, got ${armModels.length}`);
  const table = armModels.length === 2 ? PREFERENCE.pair : PREFERENCE.single;
  const judge = firstFree(table.judge, new Set(armModels));
  const second = firstFree(table.second, new Set([...armModels, judge.model]));
  return { judge, second };
}

export interface Criterion {
  id: string;
  ask: string;
}

/** One presentation of an item to a judge. It names texts by role only, never by arm, model or cost. */
export interface JudgeQuestion {
  instructions: string;
  criteria: readonly Criterion[];
  labels: readonly [string, ...string[]];
  /** The criterion whose verdict is the item's outcome. */
  decisive: string;
  texts: Readonly<Record<string, string>>;
  /** Maps this order's labels back to the canonical order's, for a swapped pairwise presentation. */
  relabel?: Readonly<Record<string, string>>;
}

export interface JudgeRequest {
  prompt: string;
  schema: ZodType<unknown>;
}

export type JudgeCall =
  | { ok: true; answer: unknown; costUsd: number; sessionId: string; effortSeen: string[] | null }
  | { ok: false; reason: string; costUsd: number };

export type JudgeFn = (spec: JudgeSpec, request: JudgeRequest) => Promise<JudgeCall>;

function answerSchema(labels: JudgeQuestion["labels"]) {
  const entry = z.object({ id: z.string(), verdict: z.enum(labels), cites: z.string(), evidence: z.string() });
  return z.object({ criteria: z.array(entry) });
}

export function renderPrompt(question: JudgeQuestion): string {
  const criteria = question.criteria.map((criterion) => `- ${criterion.id}: ${criterion.ask}`).join("\n");
  const texts = Object.entries(question.texts).map(([name, text]) => `<text name="${name}">\n${text}\n</text>`).join("\n\n");
  return [
    question.instructions,
    `Criteria:\n${criteria}`,
    `Answer every criterion once with its id, a verdict (one of: ${question.labels.join(", ")}), \`cites\` naming the text your evidence comes from (one of: ${Object.keys(question.texts).join(", ")}), and \`evidence\`: a short exact quote copied from that text.`,
    texts,
  ].join("\n\n");
}

export function judgeRequest(question: JudgeQuestion): JudgeRequest {
  return { prompt: renderPrompt(question), schema: answerSchema(question.labels) };
}

export interface CheckedCriterion {
  id: string;
  verdict: string;
  cites: string;
  evidence: string;
}

export interface CheckedAnswer {
  criteria: CheckedCriterion[];
  judgeErrors: number;
  /** The decisive criterion's verdict in canonical labels; null when it was dropped. */
  outcome: string | null;
}

function quoted(question: JudgeQuestion, entry: CheckedCriterion | undefined): entry is CheckedCriterion {
  const text = entry === undefined ? undefined : question.texts[entry.cites];
  return text !== undefined && entry !== undefined && quoteInText(text, entry.evidence) === true;
}

/** A criterion whose quote is not in the text it cites is dropped and counted as a judge error. */
export function checkAnswer(question: JudgeQuestion, answer: unknown): CheckedAnswer {
  const parsed = answerSchema(question.labels).safeParse(answer);
  if (!parsed.success) return { criteria: [], judgeErrors: question.criteria.length, outcome: null };
  const kept: CheckedCriterion[] = [];
  for (const criterion of question.criteria) {
    const entry = parsed.data.criteria.find((candidate) => candidate.id === criterion.id);
    if (quoted(question, entry)) kept.push({ ...entry, verdict: question.relabel?.[entry.verdict] ?? entry.verdict });
  }
  const decisive = kept.find((entry) => entry.id === question.decisive);
  return { criteria: kept, judgeErrors: question.criteria.length - kept.length, outcome: decisive?.verdict ?? null };
}

export interface ClaudePrintJudgeOptions {
  /** The claude profile the judge logs in with; from an option or CLAUDE_CONFIG_DIR, never a fixed path. */
  configDir: string;
  /** An empty directory the judge runs in; its transcript lands under the profile's project dir for it. */
  cwd: string;
  baseEnv?: NodeJS.ProcessEnv;
  maxBudgetUsd?: number;
  run?: typeof runAgent;
}

async function effortSeen(options: ClaudePrintJudgeOptions, spec: JudgeSpec, sessionId: string): Promise<string[] | null> {
  try {
    const path = transcriptPath(options.configDir, realpathSync(options.cwd), sessionId);
    return (await meterJob({ transcriptPath: path, arm: { id: "judge", ...spec } })).effortSeen;
  } catch {
    return null;
  }
}

/** One tool-less `claude -p` call per question; effort rides in the env because the harness has no effort flag. */
export function claudePrintJudge(options: ClaudePrintJudgeOptions): JudgeFn {
  return async (spec, request) => {
    const env = { ...(options.baseEnv ?? process.env), CLAUDE_CONFIG_DIR: options.configDir, CLAUDE_CODE_EFFORT_LEVEL: spec.effort };
    const result = await (options.run ?? runAgent)(
      { harness: "claude-print", prompt: request.prompt, cwd: options.cwd, model: spec.model, outputSchema: request.schema, maxTurns: 2, maxBudgetUsd: options.maxBudgetUsd ?? 2 },
      { env },
    );
    const costUsd = result.usage?.totalCostUsd ?? 0;
    if (!result.ok) return { ok: false, reason: `${result.failure.kind}: ${result.failure.reason}`, costUsd };
    return { ok: true, answer: result.output, costUsd, sessionId: result.sessionId, effortSeen: await effortSeen(options, spec, result.sessionId) };
  };
}
