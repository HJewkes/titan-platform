import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_CODEWATCH_QUESTIONS, briefQuestions, codewatchReader, type FetchCodewatchReport } from "./codewatch-questions.js";
import { MAX_REVIEWER_QUESTIONS } from "./reviewer-brief.js";

const REPO = "octo/platform";
const target = { repo: REPO, head: "a".repeat(40) };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../.codewatch/fixtures/${name}`, import.meta.url), "utf8"));
const serving = (report: unknown): FetchCodewatchReport => async () => report;

describe("codewatchReader", () => {
  it("takes the worsened report's three questions and records the schema", async () => {
    const read = codewatchReader(serving(fixture("pr-report-worsened.json")), [REPO]);

    const result = await read(target);

    expect(result?.questions).toHaveLength(3);
    expect(result?.questions[0]).toMatch(/^packages\/example\/src\/client\.ts:3 /);
    expect(result?.evidence).toEqual({ found: true, schema: "codewatch-pr-report@1", questions: 3 });
  });

  it("gives no questions for the clean report, which is still found", async () => {
    const read = codewatchReader(serving(fixture("pr-report-clean.json")), [REPO]);

    const result = await read(target);

    expect(result).toEqual({ questions: [], evidence: { found: true, schema: "codewatch-pr-report@1", questions: 0 } });
  });

  it("records found=false and no warning when the head has no artifact", async () => {
    const read = codewatchReader(serving(undefined), [REPO]);

    expect(await read(target)).toEqual({ questions: [], evidence: { found: false, schema: null, questions: 0 } });
  });

  it("records found=false with the cause when the fetch answers 404", async () => {
    const read = codewatchReader(async () => Promise.reject(new Error("HTTP 404: Not Found")), [REPO]);

    const result = await read(target);

    expect(result?.questions).toEqual([]);
    expect(result?.evidence).toMatchObject({ found: false, schema: null, questions: 0, warning: expect.stringContaining("404") });
  });

  it("gives no questions and a warning for a report with the wrong schema", async () => {
    const report = { ...(fixture("pr-report-worsened.json") as object), schema: "codewatch-pr-report@2" };
    const read = codewatchReader(serving(report), [REPO]);

    const result = await read(target);

    expect(result?.questions).toEqual([]);
    expect(result?.evidence).toMatchObject({ found: false, schema: "codewatch-pr-report@2", questions: 0, warning: expect.stringContaining("codewatch-pr-report@1") });
  });

  it("caps an oversized report at three questions", async () => {
    const report = { schema: "codewatch-pr-report@1", questions: ["a:1 one", "b:1 two", "c:1 three", "d:1 four", "e:1 five"] };
    const read = codewatchReader(serving(report), [REPO]);

    const result = await read(target);

    expect(result?.questions).toEqual(["a:1 one", "b:1 two", "c:1 three"]);
    expect(result?.evidence.questions).toBe(MAX_CODEWATCH_QUESTIONS);
  });

  it("answers undefined without fetching for a repo that publishes no report", async () => {
    let fetched = false;
    const read = codewatchReader(async () => {
      fetched = true;
      return fixture("pr-report-worsened.json");
    }, [REPO]);

    expect(await read({ ...target, repo: "octo/other" })).toBeUndefined();
    expect(fetched).toBe(false);
  });
});

describe("briefQuestions", () => {
  it("leaves the bank the rest of the eight-question cap after three codewatch questions", () => {
    const bank = Array.from({ length: 8 }, (_, i) => `bank ${i}`);

    const asked = briefQuestions(["cw 1", "cw 2", "cw 3"], bank);

    expect(asked).toHaveLength(MAX_REVIEWER_QUESTIONS);
    expect(asked.slice(0, 3)).toEqual(["cw 1", "cw 2", "cw 3"]);
    expect(asked.slice(3)).toEqual(["bank 0", "bank 1", "bank 2", "bank 3", "bank 4"]);
  });

  it("gives the whole cap to the bank when codewatch has nothing to ask", () => {
    const bank = Array.from({ length: 9 }, (_, i) => `bank ${i}`);

    expect(briefQuestions([], bank)).toEqual(bank.slice(0, MAX_REVIEWER_QUESTIONS));
  });
});
