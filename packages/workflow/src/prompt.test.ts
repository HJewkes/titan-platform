import { describe, expect, it } from "vitest";
import { buildStepVars, mustacheRenderer } from "./prompt.js";
import { createSignalParser, parseSignal } from "./signals.js";

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

  it("renders mustache placeholders and leaves unknown ones visible", () => {
    expect(mustacheRenderer("Hi {{ NAME }}, {{missing}}", { NAME: "x" })).toBe("Hi x, {{missing}}");
  });
});

describe("signals", () => {
  it("prefers the canonical marker and falls back to verdict prose", () => {
    expect(parseSignal("## Verdict: PASS\n<!-- signal: needs_revision -->")).toBe("needs_revision");
    expect(parseSignal("## Verdict: PASS")).toBe("approved");
    expect(parseSignal("Risk Score: 5")).toBe("high_risk");
    expect(parseSignal("nothing here")).toBeNull();
    expect(parseSignal(undefined)).toBeNull();
  });

  it("accepts custom pattern sets", () => {
    const parse = createSignalParser({ done: (c) => /DONE/.test(c) });
    expect(parse("all DONE")).toBe("done");
    expect(parse("## Verdict: PASS")).toBeNull();
    expect(parse("<!-- signal: done -->")).toBe("done");
  });
});
