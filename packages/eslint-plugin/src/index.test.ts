import { describe, expect, it } from "vitest";
import plugin, { recommended } from "./index.js";

describe("recommended", () => {
  it("enables every rule except the opt-in max-line-length, no-wall-clock-motion and recipe-step-in-loop at error under the titan namespace", () => {
    expect(recommended.rules).toEqual({
      "titan/max-function-lines": "error",
      "titan/no-chained-type-assertions": "error",
      "titan/no-commented-code": "error",
      "titan/no-internal-module-mock": "error",
      "titan/todo-needs-issue": "error",
    });
  });

  it("registers the plugin under the titan namespace", () => {
    expect(recommended.plugins?.["titan"]).toBe(plugin);
  });

  it("registers the opt-in rules on the plugin for repos that opt in", () => {
    expect(Object.keys(plugin.rules ?? {})).toEqual(expect.arrayContaining(["max-line-length", "no-wall-clock-motion", "recipe-step-in-loop"]));
  });
});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

function namesClasses(rule: unknown): boolean {
  const classes = field(field(field(rule, "meta"), "docs"), "classes");
  return Array.isArray(classes) && classes.length > 0 && classes.every((key) => typeof key === "string" && key.length > 0);
}

describe("rule classes", () => {
  it("every rule names at least one class", () => {
    const unclassed = Object.entries(plugin.rules ?? {})
      .filter(([, rule]) => !namesClasses(rule))
      .map(([name]) => name);
    expect(unclassed).toEqual([]);
  });
});
