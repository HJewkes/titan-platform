import { describe, expect, it } from "vitest";

import { parseProfile } from "./index.js";

const valid = { model: "sonnet", allowedTools: ["Read"], isolation: "none", surface: "headless" };

describe("unknown profile keys", () => {
  it("warns with the file and key for a field AgentProfile does not have", () => {
    const loaded = parseProfile("typo", { ...valid, deniedTools: ["Monitor"] }, "/profiles/typo.json");

    expect(loaded).toMatchObject({ name: "typo", model: "sonnet" });
    expect(loaded).toHaveProperty("warnings", [expect.stringMatching(/typo\.json.*"deniedTools"/)]);
  });

  it("gives a valid profile no warnings", () => {
    const parsed = parseProfile("ok", { ...valid, disallowedTools: ["Monitor"], effort: "low" });

    expect(parsed).not.toHaveProperty("warnings");
  });

  it("names every unknown key", () => {
    const parsed = parseProfile("two", { ...valid, deniedTools: [], extra: 1 });

    expect(parsed).toHaveProperty("warnings", [
      expect.stringContaining('"deniedTools"'),
      expect.stringContaining('"extra"'),
    ]);
  });
});
