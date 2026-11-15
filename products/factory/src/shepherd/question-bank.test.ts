import { describe, expect, it } from "vitest";
import { MAX_REVIEWER_QUESTIONS } from "@titan-design/review-panel";
import { QUESTION_BANK, bankQuestions } from "./question-bank.js";

const idsFor = (paths: readonly string[]) => bankQuestions(paths).map((entry) => entry.id);

describe("question bank selection", () => {
  it("selects the README claim question for a package README", () => {
    expect(idsFor(["packages/widget/README.md"])).toContain("readme-behaviour-claims");
  });

  it("selects the README claim question for a site guide", () => {
    expect(idsFor(["site/guides/contributing.md"])).toContain("readme-behaviour-claims");
  });

  it("selects the README claim question for a root README", () => {
    expect(idsFor(["README.md"])).toContain("readme-behaviour-claims");
  });

  it("does not select the README claim question for a source-only diff", () => {
    expect(idsFor(["packages/widget/src/index.ts"])).not.toContain("readme-behaviour-claims");
  });

  it("selects the provenance question for a file that reads workflow runs", () => {
    expect(idsFor(["products/factory/src/shepherd/main-ci-reads.ts"])).toContain("workflow-run-provenance");
  });

  it("selects the provenance question for a workflow-run reader under any directory", () => {
    expect(idsFor(["products/factory/src/shepherd/workflow-ci-proof.ts"])).toContain("workflow-run-provenance");
  });

  it("does not select the provenance question for an unrelated source file", () => {
    expect(idsFor(["packages/widget/src/index.ts"])).not.toContain("workflow-run-provenance");
  });

  it("selects nothing for an empty diff", () => {
    expect(bankQuestions([])).toEqual([]);
  });

  it("selects an entry once however many of its paths match", () => {
    const ids = idsFor(["README.md", "packages/a/README.md", "site/guides/x.md"]);
    expect(ids.filter((id) => id === "readme-behaviour-claims")).toHaveLength(1);
  });

  it("selects both entries when the diff touches both kinds of path", () => {
    expect(idsFor(["README.md", "products/factory/src/shepherd/main-ci-reads.ts"])).toEqual(expect.arrayContaining(["readme-behaviour-claims", "workflow-run-provenance"]));
  });

  it("caps the selection at the brief's question cap", () => {
    expect(bankQuestions(["README.md", "products/factory/src/shepherd/main-ci-reads.ts"]).length).toBeLessThanOrEqual(MAX_REVIEWER_QUESTIONS);
  });
});

describe("question bank entries", () => {
  it("gives every entry a unique id", () => {
    const ids = QUESTION_BANK.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every question short, single-line and free of verdict words", () => {
    for (const { question } of QUESTION_BANK) {
      expect(question).not.toMatch(/\n/);
      expect(question.length).toBeLessThanOrEqual(240);
      expect(question).not.toMatch(/\b(verdict|merge|fix_first)\b/i);
    }
  });
});
