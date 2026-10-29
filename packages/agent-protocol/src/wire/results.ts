import { z } from "zod";
import {
  AgentLifecycleSchema,
  AgentOriginSchema,
  AgentRoleSchema,
  CacheTtlSchema,
  EffortLevelSchema,
  HarnessSchema,
  IsolationNameSchema,
  LauncherSchema,
  PushPolicySchema,
  ReturnContractSchema,
  SettingSourceSchema,
  SpawnRefusalCodeSchema,
  SurfaceLifetimeSchema,
  SurfaceNameSchema,
  objectFor,
  type WireParseMode,
} from "./names.js";
import { buildRequestSchemas } from "./requests.js";

const correlated = { rid: z.number().optional() };

/** The profile fields that are safe to carry to another host: none runs something or sets its environment. */
const portableProfileFields = {
  name: z.string(),
  description: z.string(),
  /** Absent means `claude-code`. */
  harness: HarnessSchema.optional(),
  model: z.string(),
  /** The permission lever: the narrowest set that completes the work. */
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()).optional(),
  isolation: IsolationNameSchema,
  surface: SurfaceNameSchema,
  surfaceLifetime: SurfaceLifetimeSchema.optional(),
  /** Absent means `worker`: spawning and Remote Control are opted into, never granted by omission. */
  role: AgentRoleSchema.optional(),
  remoteControl: z.boolean().optional(),
  returnContract: z.union([ReturnContractSchema, z.literal("none")]).optional(),
  effort: EffortLevelSchema.optional(),
  cacheTtl: CacheTtlSchema.optional(),
  pushPolicy: PushPolicySchema.optional(),
  promptPrelude: z.string(),
  strictMcpConfig: z.boolean().optional(),
  settingSources: z.array(SettingSourceSchema).optional(),
  disableSlashCommands: z.boolean().optional(),
};

function profileSchemas(mode: WireParseMode) {
  const object = objectFor(mode);
  const profile = object({
    ...portableProfileFields,
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Set by the loader, never read from a file: keys in the file no field answers to. */
    warnings: z.array(z.string()).optional(),
  });
  /** A loose parse would otherwise keep `env` on a profile whose type says it cannot carry one. */
  const remoteProfile = object({
    ...portableProfileFields,
    mcpServers: z.never().optional(),
    env: z.never().optional(),
    warnings: z.never().optional(),
  });
  return { profile, remoteProfile };
}

/** A teleport successor or remote spawn in host-neutral terms; the launching host builds every path and the env. */
function remoteLaunchSchema(mode: WireParseMode) {
  const { subscription } = buildRequestSchemas(mode);
  return objectFor(mode)({
    agentId: z.string(),
    sessionId: z.string(),
    name: z.string(),
    profile: profileSchemas(mode).remoteProfile,
    brief: z.string(),
    preamble: z.string(),
    /** The predecessor was a human's own session, so the successor has no spawner to report to. */
    adopted: z.literal(true).optional(),
    surface: SurfaceNameSchema,
    tags: z.array(z.string()).optional(),
    subscriptions: z.array(subscription).optional(),
    remoteControl: z.boolean().optional(),
    channels: z.array(z.string()).optional(),
    permissionMode: z.string().optional(),
    anchor: z.string().optional(),
    /** The only proof a later landing failure came from the caller that armed it. */
    landToken: z.string().optional(),
    successorFirst: z.literal(true).optional(),
    cwd: z.string().optional(),
    configDir: z.string().optional(),
    /** Launch with the config dir unset, on the default account. */
    configDirUnset: z.literal(true).optional(),
    /** Continue `sessionId` rather than mint it. */
    resume: z.literal(true).optional(),
  });
}

/** What a spawn, resume or retire answers with. */
function spawnResultShape(mode: WireParseMode) {
  const object = objectFor(mode);
  return {
    ok: z.boolean(),
    agentId: z.string().optional(),
    name: z.string().optional(),
    reason: z.string().optional(),
    code: SpawnRefusalCodeSchema.optional(),
    /** A machine-guard refusal clears as load drops, so the same spawn may succeed later. */
    retryable: z.boolean().optional(),
    retryAfterMs: z.number().optional(),
    warnings: z.array(z.string()).optional(),
    /** Echoed because a toolset-confined agent cannot report the tool it lacks. */
    disallowedTools: z.array(z.string()).optional(),
    /** Set on any resume: whether a conversation actually came back. */
    transcript: object({ path: z.string(), found: z.boolean() }).optional(),
    account: z.string().optional(),
    base: object({ ref: z.string(), sha: z.string() }).optional(),
    /** A keyed retry answered from the first resume's outcome; it did not launch again. */
    deduped: z.boolean().optional(),
    /** Recorded, not launched: the requester launches this on `host`. */
    launch: remoteLaunchSchema(mode).optional(),
    host: z.string().optional(),
  };
}

/** Where the agent came from and how it is placed. */
const recordOriginFields = {
  agentId: z.string(),
  name: z.string(),
  profile: z.string(),
  state: AgentLifecycleSchema,
  origin: AgentOriginSchema,
  spawnedBy: z.string(),
  launchedBy: LauncherSchema.optional(),
  spawnedAt: z.number(),
  /** Read off the broker's own fold; an `agents` reply leaves it out. */
  brief: z.string().optional(),
  cwd: z.string(),
  /** Plain strings: read back from stored rows that an older binary may have written. */
  isolation: z.string(),
  surface: z.string(),
  /** The resume handle; maps to `ConversationIdentity.nativeId` with harness `claude`. */
  sessionId: z.string(),
  configDir: z.string().optional(),
  configDirUnset: z.boolean().optional(),
  host: z.string().optional(),
  /** The current name was derived from the session's directory, not chosen. */
  provisionalName: z.literal(true).optional(),
};

/** What the agent is working on and what became of it. */
function recordWorkShape(mode: WireParseMode) {
  const object = objectFor(mode);
  return {
    repo: z.string().optional(),
    branch: z.string().optional(),
    base: object({ sha: z.string(), ref: z.string() }).optional(),
    task: z.string().optional(),
    workRole: z.string().optional(),
    workRoleInferred: z.literal(true).optional(),
    lastEventAt: z.number(),
    exitedAt: z.number().optional(),
    detachedAt: z.number().optional(),
    /** Teleports deep, from 1; broker-derived, so it is lineage rather than a claim. */
    generation: z.number(),
    teleportFrom: z.string().optional(),
    /** `null` when the spawn row records none; absent when the row cannot say. */
    predecessor: z.string().nullable().optional(),
    /** `failedToStart` separates "ran and finished" from "never came up"; it is an exit, not a lifecycle. */
    exit: object({
      code: z.number().nullable(),
      summary: z.string(),
      costUsd: z.number().optional(),
      failedToStart: z.boolean().optional(),
      inferred: z.boolean().optional(),
    }).optional(),
  };
}

export function buildResultSchemas(mode: WireParseMode) {
  const object = objectFor(mode);
  const { profile, remoteProfile } = profileSchemas(mode);
  const spawnResultFields = object(spawnResultShape(mode));
  const agentRecord = object({ ...recordOriginFields, ...recordWorkShape(mode) });
  const rosterHidden = object({ finished: z.number(), retired: z.number(), overLimit: z.number() });
  const spawnResult = object({ ...correlated, t: z.literal("spawn_result"), ...spawnResultShape(mode) });
  const agentsResult = object({
    ...correlated,
    t: z.literal("agents_result"),
    agents: z.array(agentRecord),
    slots: object({ held: z.number(), cap: z.number() }).optional(),
    /** Present only when the request carried a `view` and the broker applied it. */
    hidden: rosterHidden.optional(),
  });
  /** `surface` is where the agent actually landed, which a fallback can make differ from the request. */
  const switchResult = object({
    ...correlated,
    t: z.literal("switch_result"),
    ok: z.boolean(),
    reason: z.string().optional(),
    name: z.string().optional(),
    agentId: z.string().optional(),
    surface: SurfaceNameSchema.optional(),
    warnings: z.array(z.string()).optional(),
  });
  const remoteLaunch = remoteLaunchSchema(mode);
  return { profile, remoteProfile, remoteLaunch, spawnResultFields, agentRecord, rosterHidden, spawnResult, agentsResult, switchResult };
}
