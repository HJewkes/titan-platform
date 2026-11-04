import { readFileSync } from "node:fs";
import { buildRequestSchemas, type AgentListRequest, type ResumeRequest, type RetireRequest, type SpawnRequest, type SurfaceRequest } from "./requests.js";
import { buildResultSchemas } from "./results.js";
import type { AgentListResult, AgentProfile, AgentRecord, RemoteLaunch, SpawnResult, SurfaceResult } from "./result-types.js";

const FIXTURES = new URL("../../fixtures/wire/v1/", import.meta.url);

/** The shipped synthetic fixtures, each with every field the contract names populated. */
export const readFixture = (name: string): Record<string, Record<string, unknown>> => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

export const socketFixture = readFixture("socket-frames.json");
export const recordFixture = readFixture("records.json");
export const mcpArgsFixture = readFixture("mcp-args.json");

export const exactRequests = buildRequestSchemas("exact");
export const exactResults = buildResultSchemas("exact");

export const spawnRequest: SpawnRequest = exactRequests.spawn.parse(socketFixture.spawn);
export const resumeRequest: ResumeRequest = exactRequests.resume.parse(socketFixture.resume);
export const retireRequest: RetireRequest = exactRequests.retire.parse(socketFixture.retire);
export const agentListRequest: AgentListRequest = exactRequests.agents.parse(socketFixture.agents);
export const surfaceRequest: SurfaceRequest = exactRequests.surface.parse(socketFixture.surface);
export const spawnResult: SpawnResult = exactResults.spawnResult.parse(socketFixture.spawn_result);
export const agentListResult: AgentListResult = exactResults.agentsResult.parse(socketFixture.agents_result);
export const surfaceResult: SurfaceResult = exactResults.switchResult.parse(socketFixture.switch_result);
export const agentProfile: AgentProfile = exactResults.profile.parse(recordFixture.profile);
export const remoteLaunch: RemoteLaunch = exactResults.remoteLaunch.parse(recordFixture.remote_launch);
export const agentRecord: AgentRecord = exactResults.agentRecord.parse(recordFixture.agent_record);

/** A copy of `value` without `keys`, for a frame that must omit a field. */
export function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
