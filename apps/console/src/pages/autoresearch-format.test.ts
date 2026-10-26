import { describe, expect, it } from "vitest";
import { reasonLabel } from "./autoresearch-format.js";

describe("autoresearch reason labels", () => {
  it("names the check an L0 static rejection failed", () => {
    expect(reasonLabel("rejected:post:unit")).toBe("L0 static check failed: unit");
  });

  it("names the guard and the step a generic code carries", () => {
    expect(reasonLabel("guard:single_caller")).toBe("guard exceeded: single_caller");
    expect(reasonLabel("error:ar-l1:3/i-77aa")).toBe("step failed: ar-l1:3/i-77aa");
  });

  it("reads a re-evaluation reject as the inner reason, measured on the new head", () => {
    expect(reasonLabel("reeval:not-better")).toBe("re-evaluated on the new head: Δ ≤ 0");
    expect(reasonLabel("reeval:rejected:post:unit")).toBe("re-evaluated on the new head: L0 static check failed: unit");
  });

  it("keeps an unlisted re-evaluation reason readable as its bare code", () => {
    expect(reasonLabel("reeval:in-band")).toBe("re-evaluated on the new head: in-band");
  });

  it("gives no label for a code the design does not list", () => {
    expect(reasonLabel("in-band")).toBeUndefined();
  });
});
