import { describe, expect, it } from "vitest";
import { fileRecall, globCoversArea, parsePlanSlices, scorePlan } from "./score.js";

const block = (slices: object[]): string => `Goal: ship it.\n\n\`\`\`json\n${JSON.stringify({ slices })}\n\`\`\`\n`;
const slice = (title: string, owns: string[]) => ({ title, owns, estimate: 1, tests: ["a.test.ts: works"] });

describe("scorePlan", () => {
  it("gives a signed error of -2 for three planned slices against five landed", () => {
    const plan = block([slice("one", ["packages/a/**"]), slice("two", ["packages/b/**"]), slice("three", ["site/**"])]);

    const score = scorePlan(plan, { slicesLanded: 5, areas: ["packages/a"] });

    expect(score).toMatchObject({ parse: "ok", slicesPlanned: 3, slicesLanded: 5, sliceError: -2 });
  });

  it("scores a plan with no JSON block as parse-fail, not as zero slices", () => {
    const score = scorePlan("1. Do the thing.\n2. Test it.", { slicesLanded: 1, areas: ["packages/a"] });

    expect(score).toEqual({ parse: "parse-fail", slicesPlanned: null, slicesLanded: 1, sliceError: null, fileRecall: null });
  });

  it("scores a block that is not a slice list as parse-fail", () => {
    expect(scorePlan("```json\n{\"slices\": []}\n```", { slicesLanded: 1, areas: [] }).parse).toBe("parse-fail");
    expect(scorePlan("```json\n{not json}\n```", { slicesLanded: 1, areas: [] }).parse).toBe("parse-fail");
  });

  it("reads the last fenced JSON block when the plan shows an example earlier", () => {
    const plan = `${block([slice("draft", ["x/**"])])}\nFinal:\n${block([slice("one", ["a/**"]), slice("two", ["b/**"])])}`;

    expect(parsePlanSlices(plan)?.map((entry) => entry.title)).toEqual(["one", "two"]);
  });

  it("accepts a single owns string as one glob", () => {
    expect(parsePlanSlices(block([{ title: "one", owns: "products/evals/src/**" }]))?.[0]?.owns).toEqual(["products/evals/src/**"]);
  });
});

describe("fileRecall", () => {
  it("counts the landed areas some owns glob reaches", () => {
    const recall = fileRecall(["products/evals/src/bench/plan/*.ts", "site/reference/evals.md"], ["products/evals", "products", "site", "packages/agent"]);

    expect(recall).toBe(0.75);
  });

  it("does not match an area that only shares a name prefix", () => {
    expect(globCoversArea("packages/agent-protocol/**", "packages/agent")).toBe(false);
    expect(globCoversArea("**/*.ts", "packages/agent")).toBe(true);
    expect(globCoversArea("./packages/**", "packages/agent")).toBe(true);
  });

  it("has no recall when nothing landed in a counted area", () => {
    expect(fileRecall(["a/**"], [])).toBeNull();
  });
});
