import { quoteInText } from "@titan-design/evidence";
import type { Embedder } from "@titan-design/embed";
import {
  BruteForceVectorIndex,
  createRetrievalEngine,
  ftsRetriever,
  vectorRetriever,
  type RetrievalEngine,
  type Retriever,
  type TierSource,
} from "@titan-design/retrieval";
import { SpanFtsTables, openDatabase, spanFtsTablesDdl, type Db } from "@titan-design/store-sqlite";
import { z } from "zod";

/**
 * Claim recall at an equal budget: every arm packs context from the same
 * corpus under the same token ceiling, and a required claim counts as present
 * when its quote occurs in what was packed. File-label recall cannot say this,
 * because a hit that names the right file may still have been cut short.
 */

export interface Chunk {
  id: string;
  text: string;
}

interface Claim {
  id: string;
  quote: string;
}

export interface ClaimQuestion {
  id: string;
  question: string;
  claims: Claim[];
}

/** An arm is lexical alone, or lexical fused with a dense list when it has an embedder. */
export interface ArmSpec {
  name: string;
  embedder?: Embedder;
}

export interface ArmRecall {
  arm: string;
  /** Mean over the questions that had at least one checkable claim. */
  meanRecall: number;
  /** Mean tokens packed per scored question. */
  usedTokens: number;
  maxUsedTokens: number;
  questionsScored: number;
  /** Claims whose quote was too short to check; left out of every denominator. */
  claimsExcluded: number;
}

interface ClaimRecallOptions {
  chunks: Chunk[];
  questions: ClaimQuestion[];
  arms: ArmSpec[];
  budget: number;
}

const ChunkSchema = z.object({ id: z.string(), text: z.string() });
const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  claims: z.array(z.object({ id: z.string(), quote: z.string() })),
});

function parseJsonl<T>(label: string, jsonl: string, schema: z.ZodType<T>): T[] {
  return jsonl
    .split("\n")
    .map((line, i) => ({ line: line.trim(), number: i + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${label} line ${number}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return parsed.data;
    });
}

export const parseChunks = (jsonl: string): Chunk[] => parseJsonl("corpus", jsonl, ChunkSchema);
export const parseQuestions = (jsonl: string): ClaimQuestion[] => parseJsonl("questions", jsonl, QuestionSchema);

const CONTEXT_LIMIT = 20;
const OWNER_FIELD = "body";

function indexChunks(db: Db, chunks: Chunk[]): SpanFtsTables {
  db.exec(spanFtsTablesDdl({ name: "claims" }));
  const spans = new SpanFtsTables(db, { name: "claims" });
  chunks.forEach((chunk, i) => {
    spans.index({ ownerRef: chunk.id, field: OWNER_FIELD, sourceId: i, byteOffset: 0, byteLength: chunk.text.length }, chunk.text);
  });
  return spans;
}

async function denseRetriever(chunks: Chunk[], embedder: Embedder): Promise<Retriever> {
  const index = new BruteForceVectorIndex();
  const vectors = await embedder.embed(chunks.map((chunk) => chunk.text), { role: "document" });
  chunks.forEach((chunk, i) => {
    const vector = vectors[i];
    if (vector) index.add(chunk.id, vector);
  });
  return vectorRetriever(embedder, index);
}

async function buildEngine(arm: ArmSpec, chunks: Chunk[], spans: SpanFtsTables): Promise<RetrievalEngine> {
  const retrievers = [ftsRetriever(spans)];
  if (arm.embedder) retrievers.push(await denseRetriever(chunks, arm.embedder));
  return createRetrievalEngine({ retrievers });
}

interface QuestionScore {
  recall: number | undefined;
  usedTokens: number;
  excluded: number;
}

async function scoreQuestion(
  engine: RetrievalEngine,
  tierSource: TierSource,
  question: ClaimQuestion,
  budget: number,
): Promise<QuestionScore> {
  const response = await engine.retrieve(
    { mode: "context", query: question.question, limit: CONTEXT_LIMIT, budget: { tokens: budget } },
    { tierSource },
  );
  if (response.mode !== "context") throw new Error("context mode returned a list response");
  const packed = response.entries.map((entry) => entry.text).join("\n");
  const verdicts = question.claims.map((claim) => quoteInText(packed, claim.quote));
  const checked = verdicts.filter((verdict) => verdict !== null);
  const present = checked.filter(Boolean).length;
  return {
    recall: checked.length === 0 ? undefined : present / checked.length,
    usedTokens: response.usedTokens,
    excluded: verdicts.length - checked.length,
  };
}

function summarise(arm: string, scores: QuestionScore[]): ArmRecall {
  const scored = scores.filter((score) => score.recall !== undefined);
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    arm,
    meanRecall: mean(scored.map((score) => score.recall!)),
    usedTokens: mean(scored.map((score) => score.usedTokens)),
    maxUsedTokens: Math.max(0, ...scores.map((score) => score.usedTokens)),
    questionsScored: scored.length,
    claimsExcluded: scores.reduce((sum, score) => sum + score.excluded, 0),
  };
}

export async function claimRecall(options: ClaimRecallOptions): Promise<ArmRecall[]> {
  const byId = new Map(options.chunks.map((chunk) => [chunk.id, chunk.text]));
  const tierSource: TierSource = { tiers: async (result) => [byId.get(result.id) ?? ""] };
  const db = openDatabase(":memory:");
  try {
    const spans = indexChunks(db, options.chunks);
    const rows: ArmRecall[] = [];
    for (const arm of options.arms) {
      const engine = await buildEngine(arm, options.chunks, spans);
      const scores: QuestionScore[] = [];
      for (const question of options.questions) scores.push(await scoreQuestion(engine, tierSource, question, options.budget));
      rows.push(summarise(arm.name, scores));
    }
    return rows;
  } finally {
    db.close();
  }
}
