import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commandNameToToolName, commandToTool, toolNameToCommandName } from "./mcp.js";
import { defineCommand } from "./types.js";

const naming = { prefix: "active__" };

const taskAdd = defineCommand({
  name: "task.add",
  description: "Add a task",
  args: z.object({ slug: z.string(), title: z.string(), priority: z.number().optional() }),
  result: z.object({ id: z.string() }),
  async run() {
    return { id: "T-1" };
  },
});

describe("tool naming", () => {
  it("round-trips dotted command names through the prefixed tool name", () => {
    const tool = commandNameToToolName("task.add", naming);
    expect(tool).toBe("active__task__add");
    expect(toolNameToCommandName(tool, naming)).toBe("task.add");
  });

  it("returns null for a tool that belongs to a different registry", () => {
    expect(toolNameToCommandName("brain__notes__search", naming)).toBeNull();
  });
});

describe("commandToTool", () => {
  it("derives an object inputSchema from the zod args with required fields", () => {
    const tool = commandToTool(taskAdd, naming);
    expect(tool.name).toBe("active__task__add");
    expect(tool.description).toBe("Add a task");
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toEqual(["slug", "title"]);
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["slug", "title", "priority"]);
  });

  it("strips the $schema and definitions keys some MCP clients reject", () => {
    const tool = commandToTool(taskAdd, naming);
    expect(tool.inputSchema).not.toHaveProperty("$schema");
    expect(tool.inputSchema).not.toHaveProperty("definitions");
  });
});
