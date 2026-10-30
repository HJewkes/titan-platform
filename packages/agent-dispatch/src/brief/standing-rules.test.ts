import { describe, expect, it } from "vitest";
import {
  deniesChatSend,
  SESSION_RULES,
  SPAWNED_RULES,
  STANDING_RULES_MAX_CHARS,
  standingRulesFor,
} from "./standing-rules.js";

describe("standing rules in every spawned agent’s system prompt (CC-281 a)", () => {
  it("a spawned agent is told to report to its spawner, before the session rules", () => {
    expect(standingRulesFor(false, true)).toBe(
      `${SPAWNED_RULES} ${SESSION_RULES}`
    );
  });

  it("an adopted session, a human’s own pane, gets the session rules and no spawner", () => {
    const rules = standingRulesFor(true, true);

    expect(rules).toBe(SESSION_RULES);
    expect(rules).not.toMatch(/spawner/);
  });

  it("stay within their per-spawn budget and name the report channel and the own-call rule", () => {
    expect(standingRulesFor(false, true).length).toBeLessThanOrEqual(
      STANDING_RULES_MAX_CHARS
    );
    expect(SPAWNED_RULES).toContain("chat_send");
    expect(SESSION_RULES).toContain("autoMode.allow");
    expect(SESSION_RULES).toMatch(
      /merge, a remote branch delete, a deploy or a tag push as its own/
    );
  });

  it("a profile that cannot chat_send is not told to report with it", () => {
    const rules = standingRulesFor(false, false);

    expect(rules).toBe(SESSION_RULES);
    expect(rules).not.toMatch(/spawner/);
  });

  it("a wildcard agent-chat MCP deny counts as denying chat_send", () => {
    expect(
      deniesChatSend({
        disallowedTools: ["mcp__plugin_agent-chat_agent-chat__chat_send"],
      })
    ).toBe(true);
    expect(
      deniesChatSend({
        disallowedTools: ["mcp__plugin_agent-chat_agent-chat__*"],
      })
    ).toBe(true);
    expect(deniesChatSend({ disallowedTools: ["mcp__*agent-chat*"] })).toBe(
      true
    );
  });

  it("a deny of another agent-chat tool or a Bash send leaves the report rule in place", () => {
    expect(
      deniesChatSend({
        disallowedTools: ["mcp__plugin_agent-chat_agent-chat__chat_ask"],
      })
    ).toBe(false);
    expect(
      deniesChatSend({ disallowedTools: ["Bash(agent-chat send:*)"] })
    ).toBe(false);
    expect(deniesChatSend({})).toBe(false);
  });

  it("the spawner rule leaves room for a channel the instructions name", () => {
    expect(SPAWNED_RULES).toMatch(
      /unless your instructions name another channel/
    );
  });
});
