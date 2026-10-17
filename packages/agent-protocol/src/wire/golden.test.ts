import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentSpawnArgsSchema, SpawnRequestSchema } from "./index.js";

const golden = readFileSync(new URL("./fixtures/calls-agent_spawn.txt", import.meta.url), "utf8");
const cases = golden.split(/^=== /m).filter(Boolean).map((block) => {
  const lines = block.split("\n");
  const args = lines.find((line) => line.startsWith("args: "));
  const frame = lines.find((line) => line.startsWith("frame: "));
  if (!args) throw new Error("golden case has no arguments");
  return {
    name: lines[0]!, args: JSON.parse(args.slice(6)) as unknown,
    invalid: block.includes("Error: Invalid arguments:"),
    frame: frame ? JSON.parse(frame.slice(7).replace(/ \(process fields omitted\)$/, "")) as unknown : null,
  };
});

describe("captured dispatch contract", () => {
  it.each(cases)("preserves MCP arguments: $name", ({ args, invalid }) => {
    const result = AgentSpawnArgsSchema.safeParse(args);
    expect(result.success).toBe(!invalid);
    if (result.success) expect(result.data).toEqual(args);
  });
  it.each(cases.filter((item) => item.frame !== null))("round-trips the socket projection: $name", ({ frame }) => {
    expect(SpawnRequestSchema.parse(frame)).toEqual(frame);
  });
  it("keeps the captured resume_session field independently of the socket spelling", () => {
    const resumed = cases.find((item) => typeof item.args === "object" && item.args !== null && "resume_session" in item.args);
    expect(resumed).toBeDefined();
    expect(AgentSpawnArgsSchema.parse(resumed!.args)).toHaveProperty("resume_session");
  });
});
