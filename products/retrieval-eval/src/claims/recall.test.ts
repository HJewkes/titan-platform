import { HashEmbedder } from "@titan-design/embed";
import { describe, expect, it } from "vitest";
import { claimRecall, type Chunk, type ClaimQuestion } from "./recall.js";

const CHUNKS: Chunk[] = [
  { id: "c1", text: "The zephyr gateway retries failed deliveries three times." },
  { id: "c2", text: "The zephyr gateway signs each delivery with a rotating key." },
  { id: "c3", text: "Unrelated pottery notes about glaze temperature." },
];

const QUESTION: ClaimQuestion = {
  id: "q1",
  question: "How does the zephyr gateway handle deliveries?",
  claims: [
    { id: "retry", quote: "retries failed deliveries three times" },
    { id: "sign", quote: "signs each delivery with a rotating key" },
  ],
};

const ARMS = [{ name: "fts" }, { name: "fts+hash", embedder: new HashEmbedder() }];

async function recallAt(budget: number, questions: ClaimQuestion[] = [QUESTION]) {
  return claimRecall({ chunks: CHUNKS, questions, arms: ARMS, budget });
}

describe("claimRecall", () => {
  it("scores 1 for an arm whose packed context holds both claims", async () => {
    const rows = await recallAt(200);

    expect(rows.map((row) => row.meanRecall)).toEqual([1, 1]);
  });

  it("scores 0.5 when the budget only fits the first claim's chunk", async () => {
    const rows = await recallAt(15);

    expect(rows.find((row) => row.arm === "fts")?.meanRecall).toBe(0.5);
  });

  it("keeps every arm's used tokens at or under the budget", async () => {
    const rows = await recallAt(15);

    for (const row of rows) expect(row.maxUsedTokens).toBeLessThanOrEqual(15);
    expect(rows.every((row) => row.usedTokens > 0)).toBe(true);
  });

  it("excludes a quote too short to check and counts it", async () => {
    const short = { ...QUESTION, claims: [...QUESTION.claims, { id: "tiny", quote: "a" }] };

    const rows = await recallAt(200, [short]);

    expect(rows[0]).toMatchObject({ meanRecall: 1, claimsExcluded: 1 });
  });
});
