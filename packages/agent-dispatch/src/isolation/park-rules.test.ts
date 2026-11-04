import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JournalRow } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";
import { allocatedWorktree, liveBlocker, parkable, parkBlocker, type ParkTarget } from "./index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(): string {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "park-rules-")));
  tmpDirs.push(tree);
  return tree;
}

const allocated = (agentId: string, meta: Record<string, string>, ts = 1): JournalRow => ({
  kind: "isolation_allocated",
  ts,
  actor: "broker",
  target: null,
  msgId: null,
  ref: agentId,
  body: null,
  meta,
});

const worktreeMeta = (worktree: string, extra: Record<string, string> = {}): Record<string, string> => ({
  strategy: "worktree",
  gitRoot: "/repo",
  worktree,
  branch: "agent-chat/worker-a",
  ...extra,
});

const identity = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: "a1",
  name: "worker-a",
  profile: "implementer",
  state: "exited",
  origin: "spawned",
  spawnedBy: "human",
  spawnedAt: 1,
  brief: "",
  cwd: "",
  isolation: "worktree",
  surface: "headless",
  sessionId: "sess-1",
  lastEventAt: 1,
  generation: 1,
  ...over,
});

const target = (worktree: string, assigned = false): ParkTarget => ({
  gitRoot: "/repo",
  worktree,
  branch: "agent-chat/worker-a",
  assigned,
});

describe("allocatedWorktree", () => {
  it("reads the newest allocation row for the agent", () => {
    const rows = [
      allocated("a1", worktreeMeta("/repo/.worktrees/old"), 1),
      allocated("a2", worktreeMeta("/repo/.worktrees/other"), 2),
      allocated("a1", worktreeMeta("/repo/.worktrees/new"), 3),
    ];

    expect(allocatedWorktree(rows, "a1")).toEqual(target("/repo/.worktrees/new"));
  });

  it("ignores an allocation by another strategy", () => {
    const rows = [allocated("a1", { ...worktreeMeta("/repo/.worktrees/x"), strategy: "none" })];

    expect(allocatedWorktree(rows, "a1")).toBeUndefined();
  });

  it("marks an adopted tree as assigned", () => {
    const rows = [allocated("a1", worktreeMeta("/repo/.worktrees/task", { assigned: "true" }))];

    expect(allocatedWorktree(rows, "a1")?.assigned).toBe(true);
  });
});

describe("parkBlocker", () => {
  it("refuses an agent that is still live", () => {
    const agent = identity({ state: "live" });

    expect(parkBlocker(agent, true, target(makeTree()), [agent])).toMatch(/^worker-a is live;/);
  });

  it("refuses an exited agent this broker still tracks", () => {
    const agent = identity();

    expect(parkBlocker(agent, true, target(makeTree()), [agent])).toMatch(/still tracked as running/);
  });

  it("parks a detached agent no process is tracked for, after a broker restart", () => {
    const agent = identity({ state: "detached" });

    expect(parkBlocker(agent, false, target(makeTree()), [agent])).toBeUndefined();
  });

  it("refuses an agent holding no allocated worktree, or one gone from disk", () => {
    const agent = identity();
    const gone = path.join(makeTree(), "gone");

    expect(parkBlocker(agent, false, undefined, [agent])).toMatch(/holds no worktree/);
    expect(parkBlocker(agent, false, target(gone), [agent])).toBe(`${gone} is not on disk; nothing to park`);
  });

  it("refuses a tree a live successor occupies", () => {
    const tree = makeTree();
    const agent = identity({ cwd: tree });
    const heir = identity({ agentId: "a2", name: "worker-b", state: "live", cwd: tree });

    expect(parkBlocker(agent, false, target(tree), [agent, heir])).toMatch(/^worker-b is live in /);
  });

  it("refuses a tree it adopted, since resume could not re-create it", () => {
    const agent = identity();

    expect(parkBlocker(agent, false, target(makeTree(), true), [agent])).toMatch(/was adopted by worker-a/);
  });
});

describe("parkable and liveBlocker", () => {
  it("parks only an allocated tree still on disk", () => {
    const tree = makeTree();

    expect(parkable(target(tree))).toBe(true);
    expect(parkable(target(tree, true))).toBe(false);
    expect(parkable(target(path.join(tree, "gone")))).toBe(false);
    expect(parkable(undefined)).toBe(false);
  });

  it("calls an agent live by its state, or by a process this broker still tracks", () => {
    expect(liveBlocker(identity({ state: "spawning" }), false)).toBe("spawning");
    expect(liveBlocker(identity({ state: "detached" }), true)).toBe("detached, but its process is still running");
    expect(liveBlocker(identity(), false)).toBeUndefined();
  });
});
