import { describe, expect, it } from "vitest";
import { accountLabel } from "./profile.js";

describe("accountLabel", () => {
  it.each([
    ["/srv/acct/.claude", "default"],
    ["/srv/acct/.claude/", "default"],
    [".claude", "default"],
    ["", "default"],
    ["/", "default"],
    ["/srv/acct/.claude-profiles/agents", "agents"],
    ["/srv/acct/.claude-profiles/workout/", "workout"],
    ["D:\\acct\\.claude-profiles\\server", "server"],
    ["/srv/.claude-work", "claude-work"],
  ])("labels %s as %s", (configDir, label) => {
    expect(accountLabel(configDir)).toBe(label);
  });
});
