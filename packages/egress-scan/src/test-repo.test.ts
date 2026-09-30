import { describe, expect, it } from "vitest";
import { withoutInjectedHooksPath } from "./test-repo.js";

describe("withoutInjectedHooksPath", () => {
  it("removes a lone hooksPath pair and the count", () => {
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/hooks", HOME: "/h" };

    expect(withoutInjectedHooksPath(env)).toEqual({ HOME: "/h" });
  });

  it("keeps other pairs and renumbers them", () => {
    const env = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "a",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/hooks",
      GIT_CONFIG_KEY_2: "init.defaultBranch",
      GIT_CONFIG_VALUE_2: "main",
    };

    expect(withoutInjectedHooksPath(env)).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "a",
      GIT_CONFIG_KEY_1: "init.defaultBranch",
      GIT_CONFIG_VALUE_1: "main",
    });
  });

  it("returns an env without git config pairs unchanged", () => {
    expect(withoutInjectedHooksPath({ HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});
