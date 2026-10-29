import { describe, expect, it } from "vitest";
import {
  AgentListArgsSchema,
  AgentProfilesArgsSchema,
  AgentResumeArgsSchema,
  AgentSpawnArgsSchema,
  AgentSurfaceArgsSchema,
  SpawnRequestSchema,
} from "./index.js";
import { mcpArgsFixture, socketFixture } from "./test-frames.js";

const tools = [
  ["agent_spawn", AgentSpawnArgsSchema],
  ["agent_resume", AgentResumeArgsSchema],
  ["agent_surface", AgentSurfaceArgsSchema],
  ["agent_list", AgentListArgsSchema],
  ["agent_profiles", AgentProfilesArgsSchema],
] as const;

const spawnArgs = mcpArgsFixture.agent_spawn;
const refusal = (input: unknown) => AgentSpawnArgsSchema.safeParse(input).error?.issues[0]?.message;

describe("agent tool MCP arguments", () => {
  it("covers every tool in the shipped fixture", () => {
    expect(Object.keys(mcpArgsFixture).sort()).toEqual(tools.map(([name]) => name).sort());
  });

  it.each(tools)("round-trips a fully populated %s call", (name, schema) => {
    expect(schema.parse(mcpArgsFixture[name])).toEqual(mcpArgsFixture[name]);
  });

  it.each(tools)("strips a key the %s tool does not name", (name, schema) => {
    const call = { ...mcpArgsFixture[name], not_an_arg: "x" };

    expect(schema.parse(call)).toEqual(mcpArgsFixture[name]);
  });

  it("keeps an unknown key on the socket frame that the MCP arguments would strip", () => {
    const frame = { ...socketFixture.spawn, notAField: "x" };

    expect(SpawnRequestSchema.parse(frame)).toMatchObject({ notAField: "x" });
  });

  it("refuses a blank name with the wording callers match on", () => {
    expect(refusal({ ...spawnArgs, name: "  " })).toBe("name is required and must be a non-empty string");
    expect(AgentSurfaceArgsSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("names the allowed values when a surface is out of range", () => {
    expect(refusal({ ...spawnArgs, surface: "floating" })).toBe(
      "surface must be one of: headless, iterm-pane, iterm-tab, iterm-window, tmux-window",
    );
  });

  it("accepts a numbered fix round as a role and refuses round zero or an unknown role", () => {
    const role = (value: string) => AgentSpawnArgsSchema.safeParse({ ...spawnArgs, role: value }).success;

    expect([role("reviewer"), role("fix-round-3"), role("fix-round-0"), role("tester")]).toEqual([true, true, false, false]);
  });

  it("publishes no help text, which stays with the product", () => {
    for (const [, schema] of tools) {
      for (const field of Object.values(schema.shape)) expect(field.description).toBeUndefined();
    }
  });
});
