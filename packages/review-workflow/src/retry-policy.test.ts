import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY, type RetryRule } from "./retry-policy.js";
import { FAILURE_CLASSES } from "./types.js";

const actionsOf = (rule: RetryRule): string[] => [
  ...rule.steps.map((step) => step.action),
  rule.then.kind,
  ...(rule.otherwise ? [rule.otherwise.kind] : []),
];

describe("DEFAULT_RETRY_POLICY", () => {
  it("has exactly one row for every failure class", () => {
    const classes = DEFAULT_RETRY_POLICY.map((rule) => rule.class);

    expect(new Set(classes).size).toBe(classes.length);
    expect([...classes].sort()).toEqual([...FAILURE_CLASSES].sort());
  });

  it("never routes a failure to the owner (decision 515)", () => {
    const actions = DEFAULT_RETRY_POLICY.flatMap(actionsOf);

    expect(actions).not.toContain("owner");
  });

  it("sends the deterministic classes to the fixer with no same-head retry", () => {
    const deterministic = DEFAULT_RETRY_POLICY.filter((rule) => ["start-refused:profile", "deterministic-repeat", "schema-drift"].includes(rule.class));

    expect(deterministic.map((rule) => [rule.steps.length, rule.then.kind])).toEqual([
      [0, "fixer"],
      [0, "fixer"],
      [0, "fixer"],
    ]);
  });
});
