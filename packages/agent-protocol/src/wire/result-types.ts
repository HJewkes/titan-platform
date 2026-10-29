import type { z } from "zod";
import type { Known } from "./names.js";
import { buildResultSchemas } from "./results.js";

const loose = buildResultSchemas("loose");

/** agent-chat's on-disk profile. Parsing it grants no launch or permission authority. */
export const AgentProfileSchema = loose.profile;
/** Refuses `env`, `mcpServers` and `warnings` even in a loose parse, so none crosses to a remote host. */
export const RemoteProfileSchema = loose.remoteProfile;
export const RemoteLaunchSchema = loose.remoteLaunch;
export const SpawnResultFieldsSchema = loose.spawnResultFields;
/** A roster row. Root `AgentIdentity` is the neutral handle; `AgentRecord.agentId` is that handle. */
export const AgentRecordSchema = loose.agentRecord;
export const RosterHiddenSchema = loose.rosterHidden;
/** The answer to `spawn`, `resume` and `retire`. */
export const SpawnResultSchema = loose.spawnResult;
export const AgentListResultSchema = loose.agentsResult;
/** The answer to `surface`. */
export const SurfaceResultSchema = loose.switchResult;

export type AgentProfile = Known<z.output<typeof AgentProfileSchema>>;
export type RemoteProfile = Known<z.output<typeof RemoteProfileSchema>>;
export type RemoteLaunch = Known<z.output<typeof RemoteLaunchSchema>>;
export type SpawnResultFields = Known<z.output<typeof SpawnResultFieldsSchema>>;
export type AgentRecord = Known<z.output<typeof AgentRecordSchema>>;
export type RosterHidden = Known<z.output<typeof RosterHiddenSchema>>;
export type SpawnResult = Known<z.output<typeof SpawnResultSchema>>;
export type AgentListResult = Known<z.output<typeof AgentListResultSchema>>;
export type SurfaceResult = Known<z.output<typeof SurfaceResultSchema>>;
