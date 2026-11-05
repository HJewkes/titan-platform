import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { gatherDemo as gather } from "../../article-fixtures.test-helpers.js";
import { checkClaims, parseArticleFacts, writeArticleGather } from "./gather-article.js";

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("gatherArticle facts", () => {
  it("keeps claims and numbers whose quotes are verbatim, short and state the number, sorted by id", async () => {
    const { facts } = await gather();

    expect(facts.map((fact) => fact.id)).toEqual(["claim/diff-only-converges", "figure/figure-1", "figure/table-2", "number/rounds-after", "number/simulated-prs"]);
    expect(facts.find((fact) => fact.id === "number/rounds-after")).toMatchObject({ kind: "number", value: 1.32, unit: "rounds", source: { label: "Fewer Rounds by Design", ref: "article.md" } });
  });

  it("rejects a paraphrased quote, an over-long quote and a quote that does not state the number, each with its reason", async () => {
    const { rejected } = await gather();

    expect(rejected.map(({ claim, reason }) => [z.object({ id: z.string() }).parse(claim).id, reason])).toEqual([
      ["paraphrased", "the quote is not verbatim in the article"],
      ["whole-abstract", "the quote runs 41 words; the limit is 25"],
      ["wrong-number", "the quote does not state 1.3"],
    ]);
  });

  it("writes facts.jsonl that reads back to the same facts, the same bytes on a second run", async () => {
    scratch = await mkdtemp(join(tmpdir(), "gather-article-"));
    const first = await writeArticleGather(join(scratch, "a"), await gather());
    const second = await writeArticleGather(join(scratch, "b"), await gather());
    const jsonl = await readFile(first.facts, "utf8");

    expect(jsonl).toBe(await readFile(second.facts, "utf8"));
    expect(parseArticleFacts(jsonl)).toEqual((await gather()).facts);
    expect(JSON.parse(await readFile(first.rejected, "utf8"))).toMatchObject({ rejected: [{}, {}, {}], notes: [{}, {}] });
  });
});

describe("claim checks", () => {
  it("rejects a malformed claim and a second claim under an accepted id", () => {
    const text = "Alpha beta gamma.";
    const ok = { id: "a", kind: "claim", text: "t", quote: "beta gamma" };

    const { accepted, rejected } = checkClaims([ok, { ...ok }, { id: "Bad Id", kind: "claim", text: "t", quote: "beta" }, { id: "n", kind: "number", text: "t", quote: "beta" }], text);

    expect(accepted.map((claim) => claim.id)).toEqual(["a"]);
    expect(rejected.map(({ reason }) => reason)).toEqual(["duplicate claim id a", "not a claim: expected a kebab-case claim id", "not a claim: a number claim carries its value"]);
  });

  it("honours a tighter quote limit", () => {
    const { rejected } = checkClaims([{ id: "a", kind: "claim", text: "t", quote: "alpha beta gamma" }], "alpha beta gamma", 2);

    expect(rejected[0]?.reason).toBe("the quote runs 3 words; the limit is 2");
  });
});
