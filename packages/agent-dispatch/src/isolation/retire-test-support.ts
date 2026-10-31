import type { JournalRow } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";

export const ROOT = "/repo";

export const agent = (
  name: string,
  over: Partial<AgentIdentity> = {}
): AgentIdentity => ({
  agentId: `id-${name}`,
  name,
  profile: "implementer",
  state: "exited",
  origin: "spawned",
  spawnedBy: "coord",
  spawnedAt: 1,
  brief: "",
  cwd: "",
  isolation: "worktree",
  surface: "headless",
  sessionId: "sess",
  lastEventAt: 1,
  generation: 1,
  ...over,
});

/** Only the allocation row, as after a park, which writes none of its own. */
export const allocated = (
  name: string,
  branch: string,
  worktree = `${ROOT}/.worktrees/${name}`,
  extra: Record<string, string> = {}
): JournalRow => ({
  kind: "isolation_allocated",
  ts: 1,
  actor: name,
  target: null,
  msgId: null,
  ref: `id-${name}`,
  body: null,
  meta: { strategy: "worktree", gitRoot: ROOT, worktree, branch, ...extra },
});
