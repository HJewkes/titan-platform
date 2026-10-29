import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ScoreCardSchema, totalOf } from "./score-card.js";
import { transcriptForScoring } from "./score.js";
import { VERDICTS, writeCase, type EvalCase, type Gold } from "./step-rows.js";

const CaseSchema = z.object({
  step: z.string(),
  video_id: z.string(),
  label: z.string(),
  inputs: z.object({ transcript_path: z.string(), transcript_sha256: z.string(), title: z.string(), partial: z.boolean() }),
  prompt_sha: z.string(),
  model: z.string(),
  output: z.unknown().default(null),
  gold: z.object({ verdict: z.enum(VERDICTS), total: z.int().min(0).max(15).optional(), note: z.string().optional() }).optional(),
});

const StoredCardSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  total: z.int(),
  partial: z.boolean(),
  prompt_sha: z.string(),
  model: z.string(),
});

/** The fields eval reads from a stored card file or from the output of an automatic case. */
const OutputSchema = z.looseObject({ total: z.number().optional(), card: ScoreCardSchema.optional() });

export type CardFile = z.infer<typeof StoredCardSchema>;

export function readStoredCard(file: string): CardFile {
  return StoredCardSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function outputFields(c: EvalCase): z.infer<typeof OutputSchema> {
  const parsed = OutputSchema.safeParse(c.output);
  return parsed.success ? parsed.data : {};
}

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
  const out = outputFields(c);
  if (out.total !== undefined) return out.total;
  return out.card ? totalOf(out.card) : undefined;
}

interface FlagInput {
  id: string;
  transcriptPath: string;
  cardPath: string;
  verdict: Gold["verdict"];
  goldTotal?: number;
  note?: string;
}

/** A case built from the stored card; the sha is of the text the model saw, so it uses the card's own `partial`. */
function caseFromCard(input: FlagInput): EvalCase {
  const card = readStoredCard(input.cardPath);
  const transcript = transcriptForScoring(readFileSync(input.transcriptPath, "utf8"), card.partial);
  return {
    step: "score",
    video_id: input.id,
    label: input.verdict,
    inputs: { transcript_path: path.resolve(input.transcriptPath), transcript_sha256: createHash("sha256").update(transcript).digest("hex"), title: card.title, partial: card.partial },
    prompt_sha: card.prompt_sha,
    model: card.model,
    output: card,
  };
}

/** Records the transcript's path and sha256, never its text. An existing case keeps its label and inputs and gains the gold, so it needs no card: a schema failure never wrote one. */
export function flagCase(casesDir: string, input: FlagInput): string {
  const gold: Gold = { verdict: input.verdict, ...(input.goldTotal !== undefined && { total: input.goldTotal }), ...(input.note && { note: input.note }) };
  const existing = readCases(casesDir).find((c) => c.step === "score" && c.video_id === input.id);
  return writeCase(casesDir, { ...(existing ?? caseFromCard(input)), gold });
}
