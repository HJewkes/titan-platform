import { describe, expect, it } from "vitest";
import { stepPhase } from "./step-phase.js";

const HEAD = "a".repeat(40);

describe("stepPhase", () => {
  it("labels a wait for a new head after a no-verdict diagnosis as diagnosis", () => {
    expect(stepPhase("await-new-head:0", `sh-no-verdict-diagnosis:${HEAD}`)).toBe("diagnosis");
    expect(stepPhase("sh-await-new-head", `sh-no-verdict-diagnosis:${HEAD}`)).toBe("diagnosis");
  });

  it("labels a wait for a new head after any other step as fixing", () => {
    expect(stepPhase("await-new-head:0", "sh-wake-fix-first:abc")).toBe("fixing");
    expect(stepPhase("await-new-head:0")).toBe("fixing");
  });

  it("leaves other steps in their own phase whatever ran before", () => {
    expect(stepPhase("sh-review:abc", `sh-no-verdict-diagnosis:${HEAD}`)).toBe("review");
  });
});
