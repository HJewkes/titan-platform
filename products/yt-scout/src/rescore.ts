import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ScoreCardSchema, type ScoreCard, checkTimestamps } from "./score-card.js";
import { buildScorePrompt } from "./score-prompt.js";
import { SYSTEM_PROMPT, transcriptForScoring } from "./score.js";
import type { ScoreRunner } from "./seams.js";

export interface RescoreInput {
  runner: ScoreRunner;
  rubric: string;
  model: string;
  maxBudgetUsd: number;
  title: string;
  transcriptPath: string;
  partial: boolean;
}

type Rescore =
  | { kind: "stale"; reason: string }
  | { kind: "failed"; costUsd: number }
  | { kind: "scored"; card: ScoreCard; tsValid: boolean; costUsd: number };

/** One call with no retry and no side effects: eval must not write rows, cards or cases of its own accord. */
export async function rescore(input: RescoreInput, expectedSha?: string): Promise<Rescore> {
  let raw: string;
  try {
    raw = readFileSync(input.transcriptPath, "utf8");
  } catch {
    return { kind: "stale", reason: "transcript missing" };
  }
  const transcript = transcriptForScoring(raw, input.partial);
  if (expectedSha && createHash("sha256").update(transcript).digest("hex") !== expectedSha) return { kind: "stale", reason: "transcript changed" };
  const prompt = buildScorePrompt({ title: input.title, transcript, rubric: input.rubric, partial: input.partial });
  const outcome = await input.runner({ prompt: prompt.prompt, systemPrompt: SYSTEM_PROMPT, model: input.model, maxBudgetUsd: input.maxBudgetUsd });
  if (!outcome.ok) return { kind: "failed", costUsd: 0 };
  const parsed = ScoreCardSchema.safeParse(outcome.value.output);
  if (!parsed.success) return { kind: "failed", costUsd: outcome.value.costUsd };
  const tsValid = checkTimestamps(parsed.data.techniques, transcript).dropped.length === 0;
  return { kind: "scored", card: parsed.data, tsValid, costUsd: outcome.value.costUsd };
}
