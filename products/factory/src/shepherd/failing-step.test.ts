import { describe, expect, it } from "vitest";
import { failureIds } from "./failing-step.js";

const STAMP = "2026-10-13T12:00:00.0000000Z ";
const log = (...lines: string[]) => lines.map((line) => `${STAMP}${line}`).join("\n");

describe("failureIds", () => {
  it("names each failing vitest test once, project label dropped, under the failure banner", () => {
    const tail = log(" Failed Tests 2 ", " FAIL  |unit| a/x.test.ts > suite > one", "AssertionError", " FAIL  b/y.spec.tsx > two", " FAIL  b/y.spec.tsx > two");

    expect(failureIds(tail)).toEqual(["a/x.test.ts > suite > one", "b/y.spec.tsx > two"]);
  });

  it("names nothing when the tail holds failure headings but not the banner over them, since earlier ones may be cut", () => {
    expect(failureIds(log(" FAIL  a/x.test.ts > suite > one", "AssertionError"))).toBeUndefined();
  });

  it("takes a log with no vitest heading by its error lines, leaving out the runner's exit code", () => {
    const tail = log("##[error]A changeset is required for packages/github", "##[error]Process completed with exit code 1.");

    expect(failureIds(tail)).toEqual(["A changeset is required for packages/github"]);
  });

  it("names nothing when the only error is the runner's exit code", () => {
    expect(failureIds(log("some output", "##[error]Process completed with exit code 1."))).toBeUndefined();
  });
});
