import type { AgentListRequest, ResumeRequest, RetireRequest, SpawnRequest, SurfaceRequest } from "./requests.js";
import type { AgentListResult, AgentProfile, AgentRecord, RemoteLaunch, SpawnResult, SurfaceResult } from "./result-types.js";

/** Synthetic frames with every field the contract names populated, so an exact parse proves coverage. */
export const spawnRequest: SpawnRequest = {
  rid: 7,
  t: "spawn",
  name: "example-worker",
  profile: "implementer",
  brief: "Fix the widget.",
  cwd: "/work/example-repo",
  isolation: "worktree",
  surface: "headless",
  briefing: "example-initiative",
  worktree: "/work/example-repo/.worktrees/example-worker",
  owns: ["src/widget/**"],
  claimPaths: ["src/widget/index.ts"],
  baseRef: "origin/feat/example-parent",
  inherit: "context",
  remoteControl: false,
  forkFrom: "00000000-0000-4000-8000-000000000001",
  tags: ["example"],
  subscriptions: [{ selector: { spawnedBy: "self" }, kinds: ["agent_exited"] }],
  configDir: "/home/example/.claude-profiles/example",
  account: "least-used",
  spawnerConfigDir: "/home/example/.claude",
  resumeSession: "00000000-0000-4000-8000-000000000002",
  predecessor: "example-worker-1",
  experiment: { id: "example-exp", arm: "control" },
  returnContract: "none",
  tier: 2,
  spawnedAs: "burndown",
  callerAgent: "agent-0001",
  task: "EX-1",
  workRole: "implementer",
  override: "fix-round",
  hostPlatform: "linux",
  launchesHere: true,
  host: "example-host",
  callerHost: "example-host",
  callerHome: "/home/example",
  launchedBy: "shepherd",
  launchReason: "fix round",
  lineageFrom: "agent-0000",
};

export const resumeRequest: ResumeRequest = {
  rid: 8,
  t: "resume",
  name: "example-worker",
  surface: "iterm-tab",
  message: "Continue.",
  source: "console",
  remoteControl: true,
  nonce: "nonce-0001",
  launchedBy: "seat-watchdog",
  launchReason: "stalled",
  host: "example-host",
  callerAgent: "agent-0001",
};

export const retireRequest: RetireRequest = { rid: 9, t: "retire", name: "example-worker", force: false, caller: "example-coord", agentId: "agent-0002" };

export const agentListRequest: AgentListRequest = {
  rid: 10,
  t: "agents",
  includeRetired: false,
  view: { spawner: "example-coord", prefix: "example-", includeFinished: true, includeRetired: false, limit: 20 },
};

export const surfaceRequest: SurfaceRequest = { rid: 11, t: "surface", name: "example-worker" };

export const agentProfile: AgentProfile = {
  name: "implementer",
  description: "Writes code in a worktree.",
  harness: "claude-code",
  model: "example-model",
  allowedTools: ["Read", "Edit"],
  disallowedTools: ["WebFetch"],
  isolation: "worktree",
  surface: "headless",
  surfaceLifetime: "close-on-exit",
  role: "worker",
  remoteControl: false,
  returnContract: "implementer",
  effort: "high",
  cacheTtl: "1h",
  pushPolicy: "no-rewrite",
  promptPrelude: "Be brief.",
  mcpServers: { example: { command: "example-server" } },
  strictMcpConfig: true,
  settingSources: ["project", "local"],
  disableSlashCommands: true,
  env: { EXAMPLE_FLAG: "1" },
  warnings: ["unknown key: colour"],
};

/** A copy of `value` without `keys`, for a frame that must omit a field. */
export function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

const remoteProfile = without(agentProfile, "env", "mcpServers", "warnings");

export const remoteLaunch: RemoteLaunch = {
  agentId: "agent-0003",
  sessionId: "00000000-0000-4000-8000-000000000003",
  name: "example-worker",
  profile: remoteProfile,
  brief: "Fix the widget.",
  preamble: "You are a peer.",
  adopted: true,
  surface: "headless",
  tags: ["example"],
  subscriptions: [{ selector: { tag: "example" }, kinds: ["registered"] }],
  remoteControl: false,
  channels: ["example-channel"],
  permissionMode: "default",
  anchor: "example-anchor",
  landToken: "synthetic-not-a-credential",
  successorFirst: true,
  cwd: "/work/example-repo",
  configDir: "/home/example/.claude",
  configDirUnset: true,
  resume: true,
};

export const spawnResult: SpawnResult = {
  rid: 7,
  t: "spawn_result",
  ok: false,
  agentId: "agent-0003",
  name: "example-worker",
  reason: "the machine is busy",
  code: "machine_memory_floor",
  retryable: true,
  retryAfterMs: 5000,
  warnings: ["sharing a checkout"],
  disallowedTools: ["WebFetch"],
  transcript: { path: "/home/example/.claude/projects/x/s.jsonl", found: true },
  account: "example",
  base: { ref: "origin/main", sha: "0123456789abcdef0123456789abcdef01234567" },
  deduped: false,
  launch: remoteLaunch,
  host: "example-host",
};

export const agentRecord: AgentRecord = {
  agentId: "agent-0002",
  name: "example-worker",
  profile: "implementer",
  state: "exited",
  origin: "spawned",
  spawnedBy: "example-coord",
  launchedBy: "shepherd",
  spawnedAt: 1_700_000_000_000,
  brief: "Fix the widget.",
  cwd: "/work/example-repo",
  isolation: "worktree",
  surface: "headless",
  sessionId: "00000000-0000-4000-8000-000000000004",
  configDir: "/home/example/.claude",
  configDirUnset: false,
  host: "example-host",
  provisionalName: true,
  repo: "example-org/example-repo",
  branch: "feat/example",
  base: { sha: "0123456789abcdef0123456789abcdef01234567", ref: "origin/main" },
  task: "EX-1",
  workRole: "implementer",
  workRoleInferred: true,
  lastEventAt: 1_700_000_100_000,
  exitedAt: 1_700_000_100_000,
  detachedAt: 1_700_000_050_000,
  generation: 2,
  teleportFrom: "agent-0001",
  predecessor: null,
  exit: { code: 0, summary: "done", costUsd: 1.5, failedToStart: false, inferred: false },
};

export const agentListResult: AgentListResult = {
  rid: 10,
  t: "agents_result",
  agents: [agentRecord],
  slots: { held: 3, cap: 8 },
  hidden: { finished: 4, retired: 2, overLimit: 1 },
};

export const surfaceResult: SurfaceResult = {
  rid: 11,
  t: "switch_result",
  ok: true,
  reason: "pane anchor gone",
  name: "example-worker",
  agentId: "agent-0002",
  surface: "iterm-window",
  warnings: ["opened a window instead of a pane"],
};
