import { describe, expect, it } from "vitest";
import { ALWAYS_ASK } from "./always-ask.js";
import { categoryPolicy, isLockedCategory, parseRoutingPolicy, setCategoryMode } from "./policy.js";

const empty = parseRoutingPolicy({});

describe("categoryPolicy", () => {
  it("starts an unseen category in shadow with the plan's thresholds", () => {
    expect(categoryPolicy(empty, "tech_design")).toEqual({
      category: "tech_design",
      mode: "shadow",
      minConfidence: 0.8,
      windowDays: 30,
      minSamples: 20,
      minAgreement: 0.9,
      maxMissedRedirects: 1,
    });
  });

  it.each([...ALWAYS_ASK.map((e) => e.id), "merge_gate", "release_publish"])("holds locked %s off", (category) => {
    expect(categoryPolicy(empty, category).mode).toBe("off");
  });
});

describe("setCategoryMode", () => {
  it("raises an ordinary category to auto without touching others", () => {
    const policy = setCategoryMode(setCategoryMode(empty, "agent_ops", "auto"), "tech_design", "off");

    expect(categoryPolicy(policy, "agent_ops").mode).toBe("auto");
    expect(categoryPolicy(policy, "tech_design").mode).toBe("off");
    expect(categoryPolicy(policy, "scope_priority").mode).toBe("shadow");
  });

  it.each(["shadow", "auto"] as const)("refuses to raise an always-ask category to %s", (mode) => {
    expect(() => setCategoryMode(empty, "visual_taste", mode)).toThrow(/always-ask/);
    expect(() => setCategoryMode(empty, "merge_gate", mode)).toThrow(/always-ask/);
  });

  it("lets an always-ask category be set off", () => {
    expect(categoryPolicy(setCategoryMode(empty, "money", "off"), "money").mode).toBe("off");
  });
});

describe("parseRoutingPolicy", () => {
  it("forces a stored always-ask row back to off", () => {
    const policy = parseRoutingPolicy({
      categories: [{ category: "info_request", mode: "auto" }],
    });

    expect(policy.categories[0]?.mode).toBe("off");
    expect(categoryPolicy(policy, "info_request").mode).toBe("off");
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      parseRoutingPolicy({
        categories: [{ category: "agent_ops", mode: "on" }],
      }),
    ).toThrow();
  });
});

describe("isLockedCategory", () => {
  it("locks a charter hard stop when the caller passes the list", () => {
    expect(
      isLockedCategory("hard_stop:config edits", [...ALWAYS_ASK, { id: "hard_stop:config edits", description: "" }]),
    ).toBe(true);
    expect(isLockedCategory("hard_stop:config edits")).toBe(false);
  });
});
