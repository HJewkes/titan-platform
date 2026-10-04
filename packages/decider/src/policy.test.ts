import { describe, expect, it } from "vitest";
import { ALWAYS_ASK } from "./always-ask.js";
import {
  categoryPolicy,
  isLockedCategory,
  parseRoutingPolicy,
  setCategoryMode,
} from "./policy.js";

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

  it.each([...ALWAYS_ASK.map((e) => e.id), "merge_gate", "release_publish"])(
    "holds locked %s off",
    (category) => {
      expect(categoryPolicy(empty, category).mode).toBe("off");
    }
  );
});

describe("parseRoutingPolicy row folding", () => {
  it.each([
    [["auto", "shadow"], "shadow"],
    [["shadow", "off"], "off"],
    [["off", "auto"], "off"],
    [["auto", "auto"], "auto"],
  ] as const)("keeps the strictest mode of rows %j", (modes, expected) => {
    const policy = parseRoutingPolicy({
      categories: [
        { category: "Tech Design", mode: modes[0] },
        { category: "tech-design", mode: modes[1] },
      ],
    });

    expect(policy.categories).toHaveLength(1);
    expect(categoryPolicy(policy, "tech_design").mode).toBe(expected);
  });

  it("folds unparsed duplicate rows to the strictest mode on lookup", () => {
    const raw = {
      ...empty,
      categories: [
        ...parseRoutingPolicy({
          categories: [{ category: "a b", mode: "auto" }],
        }).categories,
        ...parseRoutingPolicy({
          categories: [{ category: "a_b", mode: "off" }],
        }).categories,
      ],
    };

    expect(categoryPolicy(raw, "a-b").mode).toBe("off");
  });

  it("keeps a symbol-only category distinct from other symbol-only ones", () => {
    const policy = parseRoutingPolicy({
      categories: [
        { category: "$", mode: "auto" },
        { category: "%", mode: "off" },
      ],
    });

    expect(categoryPolicy(policy, "$").mode).toBe("auto");
    expect(categoryPolicy(policy, "%").mode).toBe("off");
  });
});

describe("setCategoryMode", () => {
  it("raises an ordinary category to auto without touching others", () => {
    const policy = setCategoryMode(
      setCategoryMode(empty, "agent_ops", "auto"),
      "tech_design",
      "off"
    );

    expect(categoryPolicy(policy, "agent_ops").mode).toBe("auto");
    expect(categoryPolicy(policy, "tech_design").mode).toBe("off");
    expect(categoryPolicy(policy, "scope_priority").mode).toBe("shadow");
  });

  it.each(["shadow", "auto"] as const)(
    "refuses to raise an always-ask category to %s",
    (mode) => {
      expect(() => setCategoryMode(empty, "visual_taste", mode)).toThrow(
        /always-ask/
      );
      expect(() => setCategoryMode(empty, "merge_gate", mode)).toThrow(
        /always-ask/
      );
    }
  );

  it("lets an always-ask category be set off", () => {
    expect(
      categoryPolicy(setCategoryMode(empty, "money", "off"), "money").mode
    ).toBe("off");
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
      })
    ).toThrow();
  });
});

describe("isLockedCategory", () => {
  it("locks a charter hard stop when the caller passes the list", () => {
    expect(
      isLockedCategory("hard_stop:config edits", [
        ...ALWAYS_ASK,
        { id: "hard_stop:config edits", description: "" },
      ])
    ).toBe(true);
    expect(isLockedCategory("hard_stop:config edits")).toBe(false);
  });
});

describe("category spelling", () => {
  it.each([
    "Merge_Gate",
    "merge_gate ",
    "MONEY",
    " money",
    "release-publish",
    "Visual Taste",
  ])("refuses to raise %s, a respelled locked category", (category) => {
    expect(() => setCategoryMode(empty, category, "auto")).toThrow(
      /always-ask/
    );
    expect(
      categoryPolicy(
        parseRoutingPolicy({ categories: [{ category, mode: "auto" }] }),
        category
      ).mode
    ).toBe("off");
  });

  it("treats respellings of an ordinary category as one row", () => {
    const policy = setCategoryMode(
      setCategoryMode(empty, "Agent-Ops", "auto"),
      "agent_ops ",
      "shadow"
    );

    expect(policy.categories).toHaveLength(1);
    expect(categoryPolicy(policy, "AGENT OPS")).toMatchObject({
      category: "agent_ops",
      mode: "shadow",
    });
  });
});
