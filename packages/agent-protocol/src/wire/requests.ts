import { z } from "zod";
import { IsolationNameSchema, SurfaceNameSchema, SubscribableKindSchema, WakeSourceSchema } from "./names.js";
import type { AgentListRequest, ExperimentArm, ResumeRequest, RetireRequest, SpawnRequest, Subscription, SubscriptionSelector, SurfaceRequest } from "./types.js";

const SubscriptionSelectorSchema: z.ZodType<SubscriptionSelector> = z.union([
  z.object({ all: z.literal(true) }).passthrough(),
  z.object({ name: z.string() }).passthrough(),
  z.object({ tag: z.string() }).passthrough(),
  z.object({ spawnedBy: z.literal("self") }).passthrough(),
]);
export const SubscriptionSchema: z.ZodType<Subscription> = z.object({
  selector: SubscriptionSelectorSchema, kinds: z.array(SubscribableKindSchema),
}).passthrough();
const ExperimentArmSchema: z.ZodType<ExperimentArm> = z.object({ id: z.string(), arm: z.string() }).passthrough();

/** Transport shape only; account, ownership and launch authority remain broker checks. */
export const SpawnRequestSchema: z.ZodType<SpawnRequest> = z.object({
  t: z.literal("spawn"), name: z.string(), profile: z.string(), brief: z.string(),
  cwd: z.string().optional(), isolation: IsolationNameSchema.optional(), surface: SurfaceNameSchema.optional(),
  briefing: z.string().optional(), worktree: z.string().optional(), owns: z.array(z.string()).optional(),
  claimPaths: z.array(z.string()).optional(), baseRef: z.string().optional(), inherit: z.literal("context").optional(),
  remoteControl: z.boolean().optional(), forkFrom: z.string().optional(), tags: z.array(z.string()).optional(),
  subscriptions: z.array(SubscriptionSchema).optional(), configDir: z.string().optional(),
  spawnerConfigDir: z.string().optional(), resumeSession: z.string().optional(), predecessor: z.string().optional(),
  experiment: ExperimentArmSchema.optional(), returnContract: z.literal("none").optional(), tier: z.number().optional(),
  spawnedAs: z.enum(["burndown", "shepherd"]).optional(), callerAgent: z.string().optional(),
  task: z.string().optional(), workRole: z.string().optional(), override: z.literal("fix-round").optional(),
  hostPlatform: z.string().optional(), launchesHere: z.literal(true).optional(), host: z.string().optional(),
  callerHost: z.string().optional(), callerHome: z.string().optional(),
}).passthrough();

export const ResumeRequestSchema: z.ZodType<ResumeRequest> = z.object({
  t: z.literal("resume"), name: z.string(), surface: SurfaceNameSchema.optional(), message: z.string().optional(),
  source: WakeSourceSchema.optional(), remoteControl: z.boolean().optional(),
}).passthrough();
export const RetireRequestSchema: z.ZodType<RetireRequest> = z.object({
  t: z.literal("retire"), name: z.string(), force: z.boolean().optional(), caller: z.string().optional(), agentId: z.string().optional(),
}).passthrough();
export const AgentListRequestSchema: z.ZodType<AgentListRequest> = z.object({
  t: z.literal("agents"), includeRetired: z.boolean().optional(),
}).passthrough();
export const SurfaceRequestSchema: z.ZodType<SurfaceRequest> = z.object({ t: z.literal("surface"), name: z.string() }).passthrough();
