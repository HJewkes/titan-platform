import { describe, expect, it } from "vitest";
import plugin, { recommended } from "./index.js";

describe("recommended", () => {
  it("enables every rule except the opt-in max-line-length at error under the titan namespace", () => {
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

  it("registers max-line-length on the plugin for repos that opt in", () => {
    expect(Object.keys(plugin.rules ?? {})).toContain("max-line-length");
  });
});
