import { describe, expect, it } from "vitest";
import { toolFamily } from "./tool-family.js";
import { findInjectedMarker, hasMarker, parseChannelTag } from "./injected-markers.js";

describe("toolFamily", () => {
  it.each([
    ["Read", "fs_read"],
    ["Grep", "fs_read"],
    ["Bash", "bash"],
    ["Write", "fs_write"],
    ["AskUserQuestion", "ask_user"],
    ["Task", "subagent"],
    ["WebSearch", "web"],
    ["ScheduleWakeup", "scheduling"],
    ["Skill", "skill_toolsearch"],
    ["SlashCommand", "other_tool"],
  ])("maps the built-in %s", (name, family) => {
    expect(toolFamily(name)).toEqual({ family, mcpServer: null });
  });

  it("splits an agent-chat MCP name into family and server", () => {
    expect(toolFamily("mcp__plugin_agent-chat_agent-chat__chat_send")).toEqual({
      family: "mcp_agentchat",
      mcpServer: "plugin_agent-chat_agent-chat",
    });
  });

  it("keeps other MCP servers apart", () => {
    expect(toolFamily("mcp__claude_ai_Gmail__send_message")).toEqual({
      family: "mcp_other",
      mcpServer: "claude_ai_Gmail",
    });
  });

  it("reports no family for a missing name", () => {
    expect(toolFamily(null)).toEqual({ family: "none", mcpServer: null });
    expect(toolFamily("")).toEqual({ family: "none", mcpServer: null });
  });
});

describe("injected markers", () => {
  it("matches anchored markers only at the start of the text", () => {
    expect(hasMarker("[Image: original 100x100]", "image_meta")).toBe(true);
    expect(hasMarker("see [Image: original 100x100]", "image_meta")).toBe(false);
  });

  it("finds a tag past leading whitespace but not past the scan window", () => {
    expect(findInjectedMarker("\n\n<task-notification>\n<task-id>abc</task-id>")).toBe("task_notification");
    expect(findInjectedMarker(`${"x".repeat(500)}<task-notification>`)).toBeNull();
  });

  it("reads the attributes of a channel tag", () => {
    expect(parseChannelTag('<channel source="plugin:agent-chat:agent-chat" from="peer-name" msg_id="0f2cc8a1">\n[body]\n</channel>')).toEqual({
      source: "plugin:agent-chat:agent-chat",
      from: "peer-name",
      msgId: "0f2cc8a1",
      isSystem: false,
    });
  });

  it("marks a system channel frame", () => {
    expect(parseChannelTag('<channel source="plugin:agent-chat:agent-chat" from="agent-chat" system="true" count="1">')?.isSystem).toBe(true);
  });
});
