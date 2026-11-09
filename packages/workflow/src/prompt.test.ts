import { describe, expect, it } from "vitest";
import { buildStepVars, mustacheRenderer, unfilledVariables } from "./prompt.js";

describe("buildStepVars", () => {
  it("exposes params in both spellings, the run identity, and step outputs", () => {
    const vars = buildStepVars({
      id: "0123456789abcdef",
      workflowName: "review",
      params: { planId: "P-1", brief: "do it" },
      stepResults: { "plan:0": { stepId: "plan", iteration: 0, agentId: null, signal: null, completedAt: "", output: "the plan" } },
    });
    expect(vars).toMatchObject({ planId: "P-1", PLAN_ID: "P-1", brief: "do it", BRIEF: "do it", WORKFLOW_NAME: "review", INSTANCE_ID: "01234567", STEP_OUTPUT_PLAN: "the plan" });
    expect(vars.PREVIOUS_STEP_OUTPUTS).toContain("### plan");
  });

  const result = (stepId: string, output: string) => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "", output });
  const runWith = (stepResults: Record<string, ReturnType<typeof result>>) => ({ id: "0123456789abcdef", workflowName: "review", params: {}, stepResults });

  it("renders fan-out and suffixed step outputs through placeholders", () => {
    const vars = buildStepVars(runWith({ "review/src/a.ts:0": result("review/src/a.ts", "item out"), "ci-wait:final:0": result("ci-wait:final", "ci out") }));
    expect(mustacheRenderer("{{STEP_OUTPUT_REVIEW_SRC_A_TS}} / {{STEP_OUTPUT_CI_WAIT_FINAL}}", vars)).toBe("item out / ci out");
  });

  it("lets the later result win when two step ids map to the same name", () => {
    const vars = buildStepVars(runWith({ "a-b:0": result("a-b", "first"), "a/b:0": result("a/b", "second") }));
    expect(vars.STEP_OUTPUT_A_B).toBe("second");
    expect(vars.PREVIOUS_STEP_OUTPUTS).toContain("### a-b");
    expect(vars.PREVIOUS_STEP_OUTPUTS).toContain("### a/b");
  });

  it("renders mustache placeholders and leaves unknown ones visible", () => {
    expect(mustacheRenderer("Hi {{ NAME }}, {{missing}}", { NAME: "x" })).toBe("Hi x, {{missing}}");
  });
});

describe("unfilledVariables", () => {
  it("lists each missing placeholder once, sorted", () => {
    expect(unfilledVariables("{{TASK_ID}} and {{ TITLE }} and {{TASK_ID}} for {{brief}}", { brief: "x" })).toEqual(["TASK_ID", "TITLE"]);
  });

  it("returns nothing when every placeholder is supplied or there are none", () => {
    expect(unfilledVariables("Hi {{NAME}}", { NAME: "x" })).toEqual([]);
    expect(unfilledVariables("no placeholders here, {single} braces ignored", {})).toEqual([]);
  });

  it("ignores placeholders that only appear inside a supplied value", () => {
    const vars = { STEP_OUTPUT_PLAN: "the plan mentions {{LATER}}" };
    expect(unfilledVariables("Review:\n{{STEP_OUTPUT_PLAN}}", vars)).toEqual([]);
    expect(mustacheRenderer("Review:\n{{STEP_OUTPUT_PLAN}}", vars)).toContain("{{LATER}}");
  });
});
