import { describe, expect, it } from "vitest";
import {
  AgentListRequestSchema,
  AgentListResultSchema,
  AgentProfileSchema,
  RemoteProfileSchema,
  SpawnRequestSchema,
  SpawnResultSchema,
  SurfaceRequestSchema,
  buildRequestSchemas,
  buildResultSchemas,
  type SpawnRequest,
  type SurfaceRequest,
} from "./index.js";
import * as frames from "./test-frames.js";

const exactRequests = buildRequestSchemas("exact");
const exactResults = buildResultSchemas("exact");

const fullyPopulated = [
  ["spawn", exactRequests.spawn, frames.spawnRequest],
  ["resume", exactRequests.resume, frames.resumeRequest],
  ["retire", exactRequests.retire, frames.retireRequest],
  ["agents", exactRequests.agents, frames.agentListRequest],
  ["surface", exactRequests.surface, frames.surfaceRequest],
  ["profile", exactResults.profile, frames.agentProfile],
  ["remote launch", exactResults.remoteLaunch, frames.remoteLaunch],
  ["spawn_result", exactResults.spawnResult, frames.spawnResult],
  ["agents_result", exactResults.agentsResult, frames.agentListResult],
  ["switch_result", exactResults.switchResult, frames.surfaceResult],
] as const;

describe("agent-chat wire contract", () => {
  it.each(fullyPopulated)("names every field of a fully populated %s frame", (_name, schema, frame) => {
    expect(schema.parse(frame)).toEqual(frame);
  });

  it("keeps a newer peer's unknown keys at every depth in a loose parse, and refuses them in an exact one", () => {
    const row = { ...frames.agentRecord, exit: { ...frames.agentRecord.exit, newerExitField: 1 }, newerRowField: "x" };
    const frame = { ...frames.agentListResult, agents: [row], newerFrameField: true };

    expect(AgentListResultSchema.parse(frame)).toEqual(frame);
    expect(exactResults.agentsResult.safeParse(frame).success).toBe(false);
  });

  it("carries an agents request's roster view, including the finished filter and the page limit", () => {
    expect(AgentListRequestSchema.parse(frames.agentListRequest).view).toEqual({
      spawner: "example-coord",
      prefix: "example-",
      includeFinished: true,
      includeRetired: false,
      limit: 20,
    });
  });

  it("accepts a roster row without its brief, which an agents reply leaves out", () => {
    const row = frames.without(frames.agentRecord, "brief");

    expect(AgentListResultSchema.safeParse({ ...frames.agentListResult, agents: [row] }).success).toBe(true);
  });

  it("refuses a remote profile carrying env, MCP servers or loader warnings, even in a loose parse", () => {
    const { profile } = frames.remoteLaunch;

    for (const extra of [{ env: { EXAMPLE_FLAG: "1" } }, { mcpServers: {} }, { warnings: [] }]) {
      expect(RemoteProfileSchema.safeParse({ ...profile, ...extra }).success).toBe(false);
    }
    expect(AgentProfileSchema.parse(frames.agentProfile).env).toEqual({ EXAMPLE_FLAG: "1" });
  });

  it("refuses a spawn refusal code the contract does not name", () => {
    expect(SpawnResultSchema.safeParse({ ...frames.spawnResult, code: "made_up" }).success).toBe(false);
  });

  it("refuses a spawn frame missing its brief", () => {
    expect(SpawnRequestSchema.safeParse(frames.without(frames.spawnRequest, "brief")).success).toBe(false);
  });

  it("types a parsed frame without a catch-all index signature", () => {
    const parsed: SpawnRequest = SpawnRequestSchema.parse(frames.spawnRequest);
    // @ts-expect-error a key the contract does not name is a type error, not `unknown`
    const unnamed = parsed.notAField;
    // @ts-expect-error a required field stays required once the signature is gone
    const nameless: SurfaceRequest = { t: "surface" };

    expect(unnamed).toBeUndefined();
    expect(SurfaceRequestSchema.safeParse(nameless).success).toBe(false);
  });
});
