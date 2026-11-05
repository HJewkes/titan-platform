import { describe, expect, it } from "vitest";
import { PR_3117, classOf } from "./ci-policy-budget.test-helpers.js";

describe("reading the measurement run link in a PR body", () => {
  it("reads a measurement link whose owner and repo differ only in case as budget", () => {
    const link = "https://github.com/OCTO/Demo/actions/runs/123";

    expect(classOf([PR_3117], { prBody: `Measured: ${link}` })).toEqual({ kind: "budget", measurement: link });
  });

  it("refuses a measurement link whose run id is not all digits", () => {
    expect(classOf([PR_3117], { prBody: "https://github.com/octo/demo/actions/runs/12x" })).toMatchObject({ kind: "weakening" });
  });
});
