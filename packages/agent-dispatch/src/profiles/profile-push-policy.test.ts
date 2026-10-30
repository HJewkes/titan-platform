import { describe, expect, it } from "vitest";

import { parseProfile, type AgentProfile } from "./index.js";

/**
 * CC-1649 and CC-1650 at the parse step. agent-chat's own cases push through a launched git
 * environment, which needs the launch plan and the hooks dir; they return with `/launch`. Here the
 * parser's half: the value a launch reads is the file's own, and an absent field stays absent so the
 * launch applies its no-rewrite default.
 */

const valid = { model: "sonnet", allowedTools: ["Read"], isolation: "none", surface: "headless" };

function parsed(body: Record<string, unknown>): AgentProfile {
  const profile = parseProfile("fixture", { ...valid, ...body });
  if ("error" in profile) throw new Error(profile.error);
  return profile;
}

describe("the pushPolicy profile field (CC-1650)", () => {
  // Mutation caught: the parser filling in scan-only, which would turn the launch default off.
  it("leaves a file without the field with no pushPolicy, so the launch default applies", () => {
    expect(parsed({})).not.toHaveProperty("pushPolicy");
  });

  it.each(["no-rewrite", "scan-only"])("keeps an explicit %s", (pushPolicy) => {
    expect(parsed({ pushPolicy }).pushPolicy).toBe(pushPolicy);
  });

  // Mutation caught: dropping the value instead of refusing it, which reads as the default.
  it("refuses any other value, naming the allowed ones", () => {
    expect(parseProfile("bad", { ...valid, pushPolicy: "open" })).toEqual({
      error: 'bad: "pushPolicy" must be one of no-rewrite, scan-only',
    });
  });
});
