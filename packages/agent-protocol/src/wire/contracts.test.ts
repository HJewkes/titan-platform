import { readFileSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AgentEventRowSchema, AgentIdentitySchema, AgentListArgsSchema, AgentListRequestSchema,
  AgentListResultSchema, AgentProfileSchema, AgentProfilesArgsSchema, AgentResumeArgsSchema,
  AgentSurfaceArgsSchema, AgentToolTextResultSchema, LoggedEventRowSchema, RemoteLaunchSchema,
  RemoteProfileSchema, ResumeRequestSchema, RetireRequestSchema, SpawnResultSchema,
  SurfaceRequestSchema, SurfaceResultSchema,
} from "./index.js";

const object = z.record(z.string(), z.unknown());
const fixture = z.record(z.string(), object).parse(JSON.parse(readFileSync(new URL("./fixtures/dispatch-results.json", import.meta.url), "utf8")));
const row = (name: string) => object.parse(fixture[name]);
const contracts = [
  ["profile", AgentProfileSchema], ["remoteProfile", RemoteProfileSchema],
  ["launch", RemoteLaunchSchema], ["spawn", SpawnResultSchema],
  ["identity", AgentIdentitySchema], ["list", AgentListResultSchema],
  ["surface", SurfaceResultSchema], ["event", AgentEventRowSchema],
  ["loggedEvent", LoggedEventRowSchema],
] as const;

describe("legacy dispatch DTOs", () => {
  it.each(contracts)("round-trips every known field in %s", (name, schema) => {
    expect(schema.parse(fixture[name])).toEqual(fixture[name]);
  });
  it.each(contracts)("validates every populated known field in %s", (name, schema) => {
    const value = row(name);
    for (const key of Object.keys(value)) {
      expect(schema.safeParse({ ...value, [key]: Symbol("invalid field type") }).success, key).toBe(false);
    }
  });
  it.each(contracts)("preserves forward-compatible fields in %s", (name, schema) => {
    const value = { ...row(name), futureWireField: "retained" };
    expect(schema.parse(value)).toEqual(value);
  });
  it.each(contracts)("rejects a missing required field in %s", (name, schema) => {
    const value = { ...(row(name)) };
    const key = name === "remoteProfile" || name === "profile" ? "allowedTools"
      : name === "launch" || name === "identity" ? "agentId"
      : name === "event" || name === "loggedEvent" ? "meta" : "t";
    delete value[key];
    expect(schema.safeParse(value).success).toBe(false);
  });
  it("retains unknown historical surface and isolation values on durable identities", () => {
    const result = AgentIdentitySchema.parse(fixture.identity);
    expect(result.surface).toBe("legacy-unknown-surface");
    expect(result.isolation).toBe("legacy-unknown-isolation");
  });
  it("does not silently turn absent exit evidence into a success", () => {
    const identity = { ...row("identity"), exit: undefined };
    expect(AgentIdentitySchema.parse(identity).exit).toBeUndefined();
    expect(SpawnResultSchema.parse({ t: "spawn_result", ok: false })).toEqual({ t: "spawn_result", ok: false });
  });
  it("validates known nested values while preserving nullable event fields", () => {
    expect(AgentEventRowSchema.safeParse({ ...row("event"), meta: { invalid: 42 } }).success).toBe(false);
    expect(AgentIdentitySchema.safeParse({ ...row("identity"), exit: { code: null } }).success).toBe(false);
    expect(SpawnResultSchema.safeParse({ t: "spawn_result", ok: true, code: "new-unknown-refusal" }).success).toBe(false);
    expect(AgentListResultSchema.safeParse({ t: "agents_result", agents: [], slots: { held: "1", cap: 2 } }).success).toBe(false);
    expect(RemoteLaunchSchema.safeParse({ ...row("launch"), adopted: false }).success).toBe(false);
    expect(AgentEventRowSchema.parse(fixture.event).body).toBeNull();
  });
});

describe("existing MCP and socket projections", () => {
  it("preserves the distinct MCP and socket list spellings", () => {
    expect(AgentListArgsSchema.parse({ include_retired: true, mine: true, prefix: "fixture-" })).toEqual({ include_retired: true, mine: true, prefix: "fixture-" });
    expect(AgentListRequestSchema.parse({ t: "agents", includeRetired: true })).toEqual({ t: "agents", includeRetired: true });
  });
  it("retains the actual resume and profile arguments without inventing a profiles frame", () => {
    expect(AgentResumeArgsSchema.parse({ name: "fixture", message: "Continue", surface: "headless" })).toEqual({ name: "fixture", message: "Continue", surface: "headless" });
    expect(ResumeRequestSchema.parse({ t: "resume", name: "fixture", source: "watchdog" })).toEqual({ t: "resume", name: "fixture", source: "watchdog" });
    expect(AgentProfilesArgsSchema.parse({ name: "fixture-worker" })).toEqual({ name: "fixture-worker" });
    expect(AgentToolTextResultSchema.parse("No profiles available.")).toBe("No profiles available.");
    expect(AgentToolTextResultSchema.safeParse({ profiles: [] }).success).toBe(false);
  });
  it("preserves original MCP nonblank name validation", () => {
    for (const schema of [AgentResumeArgsSchema, AgentSurfaceArgsSchema]) {
      expect(schema.safeParse({ name: "   " }).success).toBe(false);
      expect(schema.parse({ name: "fixture" })).toEqual({ name: "fixture" });
    }
  });
  for (const [file, schema] of [["calls-agent-retire.txt", RetireRequestSchema], ["calls-agent_surface.txt", SurfaceRequestSchema]] as const) {
    const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
    const frames = text.split("\n").filter(line => line.startsWith("frame: ")).map(line => JSON.parse(line.slice(7)) as unknown);
    it(`${file} contains captured socket frames`, () => expect(frames.length).toBeGreaterThan(0));
    it.each(frames)(`${file} round-trips frame %#`, frame => expect(schema.parse(frame)).toEqual(frame));
  }
});
