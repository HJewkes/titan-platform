import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { totalOf } from "./score-card.js";
import { transcriptForScoring, type StoredCard } from "./score.js";
import { VERDICTS, writeCase, type EvalCase, type Gold } from "./step-rows.js";

const CaseSchema = z.object({
  step: z.string(),
  video_id: z.string(),
  label: z.string(),
  inputs: z.object({ transcript_path: z.string(), transcript_sha256: z.string() }),
  prompt_sha: z.string(),
  model: z.string(),
  output: z.unknown().default(null),
  gold: z.object({ verdict: z.enum(VERDICTS), total: z.int().min(0).max(15).optional(), note: z.string().optional() }).optional(),
});

export function readCases(casesDir: string): EvalCase[] {
  if (!existsSync(casesDir)) return [];
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => CaseSchema.parse(JSON.parse(readFileSync(path.join(casesDir, f), "utf8"))));
}

export function caseExists(casesDir: string, step: string, id: string): boolean {
  return existsSync(path.join(casesDir, `${step}-${id}.json`));
}

/** The total the owner or the recorded card gives as the answer; absent when the case holds no card, as after a schema failure. */
export function referenceTotal(c: EvalCase): number | undefined {
  if (c.gold?.total !== undefined) return c.gold.total;
  const out = c.output as { total?: unknown; card?: Parameters<typeof totalOf>[0] } | null;
  if (typeof out?.total === "number") return out.total;
  return out?.card ? totalOf(out.card) : undefined;
}

export interface FlagInput {
  id: string;
  transcriptPath: string;
  cardPath: string;
  verdict: Gold["verdict"];
  goldTotal?: number;
  note?: string;
}

/** Records the transcript's path and sha256, never its text; an existing automatic case keeps its label and gains the gold. */
export function flagCase(casesDir: string, input: FlagInput): string {
  const card = JSON.parse(readFileSync(input.cardPath, "utf8")) as StoredCard;
  const transcript = transcriptForScoring(readFileSync(input.transcriptPath, "utf8"), card.partial);
  const gold: Gold = { verdict: input.verdict, ...(input.goldTotal !== undefined && { total: input.goldTotal }), ...(input.note && { note: input.note }) };
  const existing = readCases(casesDir).find((c) => c.step === "score" && c.video_id === input.id);
  return writeCase(casesDir, {
    step: "score",
    video_id: input.id,
    label: existing?.label ?? input.verdict,
    inputs: { transcript_path: path.resolve(input.transcriptPath), transcript_sha256: createHash("sha256").update(transcript).digest("hex") },
    prompt_sha: card.prompt_sha,
    model: card.model,
    output: existing?.output ?? card,
    gold,
  });
}
