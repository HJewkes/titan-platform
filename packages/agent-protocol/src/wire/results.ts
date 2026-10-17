import { z } from "zod";
import { IsolationNameSchema, SurfaceNameSchema, SurfaceLifetimeSchema, AgentRoleSchema, ReturnContractSchema, EffortLevelSchema, SettingSourceSchema, AgentLifecycleSchema, AgentOriginSchema, EventKindSchema } from "./names.js";
import { SubscriptionSchema } from "./requests.js";
import type { AgentProfile, RemoteProfile, RemoteLaunch, SpawnResultFields, AgentIdentity, AgentEventRow, LoggedEventRow, AgentListResult, SurfaceResult, SpawnResult } from "./result-types.js";

/** Legacy transport/storage DTO shapes; parsing never grants launch or permission authority. */
export const AgentProfileSchema: z.ZodType<AgentProfile> = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()).optional(),
  isolation: IsolationNameSchema,
  surface: SurfaceNameSchema,
  surfaceLifetime: SurfaceLifetimeSchema.optional(),
  role: AgentRoleSchema.optional(),
  remoteControl: z.boolean().optional(),
  returnContract: z.union([ReturnContractSchema, z.literal('none')]).optional(),
  effort: EffortLevelSchema.optional(),
  promptPrelude: z.string(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  strictMcpConfig: z.boolean().optional(),
  settingSources: z.array(SettingSourceSchema).optional(),
  disableSlashCommands: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  warnings: z.array(z.string()).optional(),
}).passthrough();

export const RemoteProfileSchema: z.ZodType<RemoteProfile> = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()).optional(),
  isolation: IsolationNameSchema,
  surface: SurfaceNameSchema,
  surfaceLifetime: SurfaceLifetimeSchema.optional(),
  role: AgentRoleSchema.optional(),
  remoteControl: z.boolean().optional(),
  returnContract: z.union([ReturnContractSchema, z.literal('none')]).optional(),
  effort: EffortLevelSchema.optional(),
  promptPrelude: z.string(),
  strictMcpConfig: z.boolean().optional(),
  settingSources: z.array(SettingSourceSchema).optional(),
  disableSlashCommands: z.boolean().optional(),
}).passthrough();

export const RemoteLaunchSchema: z.ZodType<RemoteLaunch> = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  name: z.string(),
  profile: RemoteProfileSchema,
  brief: z.string(),
  preamble: z.string(),
  adopted: z.literal(true).optional(),
  surface: SurfaceNameSchema,
  tags: z.array(z.string()).optional(),
  subscriptions: z.array(SubscriptionSchema).optional(),
  remoteControl: z.boolean().optional(),
  channels: z.array(z.string()).optional(),
  permissionMode: z.string().optional(),
  anchor: z.string().optional(),
  landToken: z.string().optional(),
  successorFirst: z.literal(true).optional(),
  cwd: z.string().optional(),
  configDir: z.string().optional(),
  configDirUnset: z.literal(true).optional(),
}).passthrough();

export const SpawnResultFieldsSchema: z.ZodType<SpawnResultFields> = z.object({
  ok: z.boolean(),
  agentId: z.string().optional(),
  name: z.string().optional(),
  reason: z.string().optional(),
  code: z.union([z.literal('surface_refused'), z.literal('spawn_rate_limit'), z.literal('machine_headless_limit'), z.literal('machine_memory_floor'), z.literal('seat_budget_stop'), z.literal('seat_spawn_overlap'), z.literal('seat_hand_reserve'), z.literal('seat_spawn_unprefixed'), z.literal('reviewer_account_limit'), z.literal('broker_draining')]).optional(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  transcript: z.object({
  path: z.string(),
  found: z.boolean(),
}).passthrough().optional(),
  base: z.object({
  ref: z.string(),
  sha: z.string(),
}).passthrough().optional(),
  launch: RemoteLaunchSchema.optional(),
  host: z.string().optional(),
}).passthrough();

export const AgentIdentitySchema: z.ZodType<AgentIdentity> = z.object({
  agentId: z.string(),
  name: z.string(),
  profile: z.string(),
  state: AgentLifecycleSchema,
  origin: AgentOriginSchema,
  spawnedBy: z.string(),
  spawnedAt: z.number(),
  brief: z.string(),
  cwd: z.string(),
  isolation: z.string(),
  surface: z.string(),
  sessionId: z.string(),
  configDir: z.string().optional(),
  configDirUnset: z.boolean().optional(),
  host: z.string().optional(),
  provisionalName: z.literal(true).optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  base: z.object({
  sha: z.string(),
  ref: z.string(),
}).passthrough().optional(),
  task: z.string().optional(),
  workRole: z.string().optional(),
  workRoleInferred: z.literal(true).optional(),
  lastEventAt: z.number(),
  exitedAt: z.number().optional(),
  detachedAt: z.number().optional(),
  generation: z.number(),
  teleportFrom: z.string().optional(),
  exit: z.object({
  code: z.union([z.number(), z.null()]),
  summary: z.string(),
  costUsd: z.number().optional(),
  failedToStart: z.boolean().optional(),
  inferred: z.boolean().optional(),
}).passthrough().optional(),
}).passthrough();

export const AgentEventRowSchema: z.ZodType<AgentEventRow> = z.object({
  kind: EventKindSchema,
  ts: z.number(),
  actor: z.string(),
  target: z.union([z.string(), z.null()]),
  msgId: z.union([z.string(), z.null()]),
  ref: z.union([z.string(), z.null()]),
  body: z.union([z.string(), z.null()]),
  meta: z.record(z.string(), z.string()),
}).passthrough();

export const LoggedEventRowSchema: z.ZodType<LoggedEventRow> = z.object({
  kind: EventKindSchema,
  ts: z.number(),
  actor: z.string(),
  target: z.union([z.string(), z.null()]),
  msgId: z.union([z.string(), z.null()]),
  ref: z.union([z.string(), z.null()]),
  body: z.union([z.string(), z.null()]),
  meta: z.record(z.string(), z.string()),
  id: z.number(),
}).passthrough();

export const AgentListResultSchema: z.ZodType<AgentListResult> = z.object({
  t: z.literal('agents_result'),
  agents: z.array(AgentIdentitySchema),
  slots: z.object({
  held: z.number(),
  cap: z.number(),
}).passthrough().optional(),
}).passthrough();

export const SurfaceResultSchema: z.ZodType<SurfaceResult> = z.object({
  t: z.literal('switch_result'),
  ok: z.boolean(),
  reason: z.string().optional(),
  name: z.string().optional(),
  agentId: z.string().optional(),
  surface: SurfaceNameSchema.optional(),
  warnings: z.array(z.string()).optional(),
}).passthrough();

export const SpawnResultSchema: z.ZodType<SpawnResult> = z.intersection(z.object({ t: z.literal("spawn_result") }).passthrough(), SpawnResultFieldsSchema);
