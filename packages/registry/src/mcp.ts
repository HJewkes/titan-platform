import { toJSONSchema } from "zod";
import type { AnyCommand } from "./types.js";

/** The transport-agnostic MCP tool descriptor; the SDK's `Tool` is a superset. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolNaming {
  /** Prepended to every tool name so one MCP client can host several registries. */
  prefix: string;
}

/** `task.add` with prefix `active__` becomes `active__task__add`. */
export function commandNameToToolName(commandName: string, naming: ToolNaming): string {
  return naming.prefix + commandName.replaceAll(".", "__");
}

/** Inverse of commandNameToToolName; null when the tool does not carry this prefix. */
export function toolNameToCommandName(toolName: string, naming: ToolNaming): string | null {
  if (!toolName.startsWith(naming.prefix)) return null;
  return toolName.slice(naming.prefix.length).replaceAll("__", ".");
}

// Some MCP clients reject these at the root of inputSchema.
const ROOT_KEYS_TO_STRIP = new Set(["$schema", "definitions"]);

/** Build an MCP tool descriptor from a command's zod args via zod 4's native JSON Schema export. */
export function commandToTool(cmd: AnyCommand, naming: ToolNaming): McpToolDescriptor {
  const raw = toJSONSchema(cmd.args) as Record<string, unknown>;
  const inputSchema = Object.fromEntries(Object.entries(raw).filter(([key]) => !ROOT_KEYS_TO_STRIP.has(key)));
  if (inputSchema.type !== "object") inputSchema.type = "object";
  return { name: commandNameToToolName(cmd.name, naming), description: cmd.description, inputSchema };
}
