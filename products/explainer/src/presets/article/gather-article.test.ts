import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkClaims, gatherArticle, parseArticleFacts, writeArticleGather } from "./gather-article.js";
import { isVerbatim, quoteStates } from "./quotes.js";

const DEMO = fileURLToPath(new URL("../../../fixtures/article/demo", import.meta.url));
const ARTICLE = join(DEMO, "article.md");
const claims = async (): Promise<unknown[]> => JSON.parse(await readFile(join(DEMO, "claims.json"), "utf8")) as unknown[];
const gather = async () => gatherArticle({ articlePath: ARTICLE, label: "Fewer Rounds by Design", claims: await claims() });

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

    expect(rejected.map(({ claim, reason }) => [(claim as { id: string }).id, reason])).toEqual([
      ["paraphrased", "the quote is not verbatim in the article"],
      ["whole-abstract", "the quote runs 41 words; the limit is 25"],
      ["wrong-number", "the quote does not state 1.3"],
    ]);
  });

  it("extracts a numeric-x table as a line figure and a category table as a bar figure, ready to re-plot", async () => {
    const { facts } = await gather();
    const line = facts.find((fact) => fact.id === "figure/figure-1");
    const bar = facts.find((fact) => fact.id === "figure/table-2");

    expect(line?.figure).toEqual({
      kind: "line",
      x: "Pass rate",
      y: "Mean rounds per change by one-round pass rate",
      series: [
        { id: "full-re-read", label: "Full re-read", points: [{ x: 0.65, y: 2.08 }, { x: 0.7, y: 1.84 }, { x: 0.78, y: 1.55 }] },
        { id: "diff-only", label: "Diff only", points: [{ x: 0.65, y: 1.71 }, { x: 0.7, y: 1.52 }, { x: 0.78, y: 1.32 }] },
      ],
    });
    expect(line?.source.ref).toBe("article.md:14");
    expect(bar?.figure).toMatchObject({ kind: "bar", categories: ["Low", "Medium", "High"], series: [{ points: [{ x: 1, y: 640 }, { x: 2, y: 410 }, { x: 3, y: 150 }] }] });
  });

  it("notes a figure held only as an image and a table of text, and makes neither a figure", async () => {
    const { notes } = await gather();

    expect(notes.map(({ code, id }) => [code, id])).toEqual([
      ["W-FIGURE-NO-DATA", "figure-2"],
      ["W-TABLE-TEXT", "table-1"],
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

  it("matches a quote across line breaks and typographic quotes, but not a changed word", () => {
    expect(isVerbatim("the “diff” only", 'it is the "diff"\n only')).toBe(true);
    expect(isVerbatim("the diff alone", "the diff only")).toBe(false);
  });

  it("finds a number only as a whole number in the quote, with thousands separators", () => {
    expect(quoteStates("from 2.08 to 1.32", 1.32)).toBe(true);
    expect(quoteStates("from 2.08 to 1.32", 1.3)).toBe(false);
    expect(quoteStates("from 2.08 to 11.32", 1.32)).toBe(false);
    expect(quoteStates("Across 1,200 pull requests", 1200)).toBe(true);
    expect(quoteStates("Across 1,200 pull requests", 200)).toBe(false);
  });
});
