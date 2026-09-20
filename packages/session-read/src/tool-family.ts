/**
 * Tool name to cost-audit family, ported from the long-horizon research
 * extractor (`cf_extract.py:24-47`) so its published numbers stay comparable.
 */

export type ToolFamily =
  | "none"
  | "mcp_agentchat"
  | "mcp_other"
  | "fs_read"
  | "bash"
  | "fs_write"
  | "ask_user"
  | "subagent"
  | "web"
  | "scheduling"
  | "skill_toolsearch"
  | "other_tool";

export interface ToolFamilyResult {
  readonly family: ToolFamily;
  /** The server segment of an `mcp__<server>__<tool>` name, else null. */
  readonly mcpServer: string | null;
}

const BUILTIN_FAMILIES = new Map<string, ToolFamily>([
  ["Read", "fs_read"],
  ["Grep", "fs_read"],
  ["Glob", "fs_read"],
  ["NotebookEdit", "fs_read"],
  ["Bash", "bash"],
  ["Edit", "fs_write"],
  ["Write", "fs_write"],
  ["AskUserQuestion", "ask_user"],
  ["Task", "subagent"],
  ["Agent", "subagent"],
  ["WebFetch", "web"],
  ["WebSearch", "web"],
  ["Monitor", "scheduling"],
  ["ScheduleWakeup", "scheduling"],
  ["CronCreate", "scheduling"],
  ["CronList", "scheduling"],
  ["CronDelete", "scheduling"],
  ["TaskStop", "scheduling"],
  ["Skill", "skill_toolsearch"],
  ["ToolSearch", "skill_toolsearch"],
]);

const AGENTCHAT_SERVER = "agent-chat";

export function toolFamily(name: string | null | undefined): ToolFamilyResult {
  if (!name) return { family: "none", mcpServer: null };
  if (name.startsWith("mcp__")) {
    const mcpServer = name.split("__")[1] || null;
    const agentChat = mcpServer !== null && mcpServer.includes(AGENTCHAT_SERVER);
    return { family: agentChat ? "mcp_agentchat" : "mcp_other", mcpServer };
  }
  return { family: BUILTIN_FAMILIES.get(name) ?? "other_tool", mcpServer: null };
}
