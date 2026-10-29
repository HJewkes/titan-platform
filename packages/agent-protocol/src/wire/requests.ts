import { z } from "zod";
import {
  IsolationNameSchema,
  LauncherSchema,
  SubscribableKindSchema,
  SurfaceNameSchema,
  WakeSourceSchema,
  objectFor,
  type Known,
  type WireParseMode,
} from "./names.js";

/** Echoed on the reply, so a late reply can be told from a lost one; either side may predate it. */
const correlated = { rid: z.number().optional() };

/** A field the broker reads only from an unregistered connection, since a session's registration already says it. */
const unregisteredCaller = {
  callerAgent: z.string().optional(),
  launchedBy: LauncherSchema.optional(),
  /** Recorded only with `launchedBy`. */
  launchReason: z.string().optional(),
};

/** Where and from what the agent starts. */
const placementFields = {
  cwd: z.string().optional(),
  isolation: IsolationNameSchema.optional(),
  surface: SurfaceNameSchema.optional(),
  /** A worktree the task system assigned; an absolute path that must exist, bypassing the isolation strategy. */
  worktree: z.string().optional(),
  /** Path globs, relative to the worktree, the agent owns under file-ownership isolation. */
  owns: z.array(z.string()).optional(),
  /** Path globs the broker claims for the agent before it registers; isolates nothing. */
  claimPaths: z.array(z.string()).optional(),
  /** The `origin/<branch>` a worktree spawn is cut from. */
  baseRef: z.string().optional(),
  /** Start from a copy of the requester's own conversation; the broker resolves whose. */
  inherit: z.literal("context").optional(),
  /** The session id the requester claims to fork, refused when it differs from the one observed. */
  forkFrom: z.string().optional(),
  remoteControl: z.boolean().optional(),
  hostPlatform: z.string().optional(),
  /** The requester can launch on its own host; absent is an older client, launched on the broker's. */
  launchesHere: z.literal(true).optional(),
  /** The machine to launch on, a configured alias or a hostname. */
  host: z.string().optional(),
  callerHost: z.string().optional(),
  callerHome: z.string().optional(),
};

/** Which account the agent runs on. `configDir` and `account` are exclusive; the broker refuses both. */
const accountFields = {
  /** An absolute config dir that must exist; refused, never corrected, since the wrong account is the failure. */
  configDir: z.string().optional(),
  /** An account by name, `default`, or `least-used`. */
  account: z.string().optional(),
  /** The requester's own config dir, observed by its process. */
  spawnerConfigDir: z.string().optional(),
  /** A session uuid to continue, whose transcript must exist under the chosen config dir and cwd. */
  resumeSession: z.string().optional(),
};

/** Which task the agent works and in what role; the spawn row records them. */
const assignmentFields = {
  task: z.string().optional(),
  /** The plan slice of `task` this spawn runs. */
  slice: z.string().optional(),
  /** Why the requester keeps `profile` unrouted. */
  routeOverride: z.string().optional(),
  /** implementer, reviewer, fix-round-N, shepherd-review, planner or other; inferred when absent. */
  workRole: z.string().optional(),
  override: z.literal("fix-round").optional(),
};

function spawnSchema(mode: WireParseMode) {
  const { subscription, experiment } = sharedSchemas(mode);
  return objectFor(mode)({
    ...correlated,
    ...unregisteredCaller,
    ...placementFields,
    ...accountFields,
    ...assignmentFields,
    t: z.literal("spawn"),
    name: z.string(),
    profile: z.string(),
    brief: z.string(),
    /** An initiative slug or `auto`; a pointer, so the requester cannot have arbitrary files read back to it. */
    briefing: z.string().optional(),
    tags: z.array(z.string()).optional(),
    subscriptions: z.array(subscription).optional(),
    /** The name of the agent whose work this one takes over; the broker reads its report from the log. */
    predecessor: z.string().optional(),
    experiment: experiment.optional(),
    /** `none` stops the broker appending its return contract to `brief`. */
    returnContract: z.literal("none").optional(),
    tier: z.number().optional(),
    spawnedAs: z.enum(["burndown", "shepherd"]).optional(),
    /** An earlier identity of the same name whose depth this spawn keeps. */
    lineageFrom: z.string().optional(),
  });
}

function sharedSchemas(mode: WireParseMode) {
  const object = objectFor(mode);
  const selector = z.union([
    object({ all: z.literal(true) }),
    object({ name: z.string() }),
    object({ tag: z.string() }),
    object({ spawnedBy: z.literal("self") }),
  ]);
  const subscription = object({ selector, kinds: z.array(SubscribableKindSchema) });
  const experiment = object({ id: z.string(), arm: z.string() });
  const rosterView = object({
    /** Only agents spawned by this name. */
    spawner: z.string().optional(),
    prefix: z.string().optional(),
    includeFinished: z.boolean().optional(),
    includeRetired: z.boolean().optional(),
    /** Rows kept from the front of the roster, which is newest first. */
    limit: z.number().optional(),
  });
  return { selector, subscription, experiment, rosterView };
}

function resumeSchema(mode: WireParseMode) {
  return objectFor(mode)({
    ...correlated,
    ...unregisteredCaller,
    t: z.literal("resume"),
    name: z.string(),
    surface: SurfaceNameSchema.optional(),
    message: z.string().optional(),
    source: WakeSourceSchema.optional(),
    remoteControl: z.boolean().optional(),
    /** An idempotency key: a retry with the same key joins or replays the first resume. */
    nonce: z.string().optional(),
    host: z.string().optional(),
  });
}

function lifecycleSchemas(mode: WireParseMode) {
  const object = objectFor(mode);
  const resume = resumeSchema(mode);
  /** `force` destroys the commits a dirty or unmerged isolation protects; `agentId` retires that row only. */
  const retire = object({
    ...correlated,
    t: z.literal("retire"),
    name: z.string(),
    force: z.boolean().optional(),
    caller: z.string().optional(),
    agentId: z.string().optional(),
  });
  /** An older broker ignores `view` and sends the whole roster, so a client applies it again on receipt. */
  const agents = object({
    ...correlated,
    t: z.literal("agents"),
    includeRetired: z.boolean().optional(),
    view: sharedSchemas(mode).rosterView.optional(),
  });
  /** Pulls a headless agent into a terminal window; it only widens what a human can see. */
  const surface = object({ ...correlated, t: z.literal("surface"), name: z.string() });
  return { resume, retire, agents, surface };
}

export function buildRequestSchemas(mode: WireParseMode) {
  const { subscription, experiment, rosterView } = sharedSchemas(mode);
  return { subscription, experiment, rosterView, spawn: spawnSchema(mode), ...lifecycleSchemas(mode) };
}

const loose = buildRequestSchemas("loose");

/** Transport shape only: account, ownership and launch authority stay broker checks. */
export const SpawnRequestSchema = loose.spawn;
export const ResumeRequestSchema = loose.resume;
export const RetireRequestSchema = loose.retire;
export const AgentListRequestSchema = loose.agents;
export const SurfaceRequestSchema = loose.surface;
export const SubscriptionSchema = loose.subscription;
export const ExperimentArmSchema = loose.experiment;
export const RosterViewSchema = loose.rosterView;

export type SpawnRequest = Known<z.output<typeof SpawnRequestSchema>>;
export type ResumeRequest = Known<z.output<typeof ResumeRequestSchema>>;
export type RetireRequest = Known<z.output<typeof RetireRequestSchema>>;
export type AgentListRequest = Known<z.output<typeof AgentListRequestSchema>>;
export type SurfaceRequest = Known<z.output<typeof SurfaceRequestSchema>>;
export type Subscription = Known<z.output<typeof SubscriptionSchema>>;
export type SubscriptionSelector = Subscription["selector"];
export type ExperimentArm = Known<z.output<typeof ExperimentArmSchema>>;
export type RosterView = Known<z.output<typeof RosterViewSchema>>;
