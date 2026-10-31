import { describe, expect, it } from "vitest";
import {
  composite,
  createIsolationRegistry,
  isWarning,
  type IsolationContext,
  type IsolationStrategy,
  type ReleaseOptions,
} from "./index.js";

const ctxFor = (cwd: string, overrides: Partial<IsolationContext> = {}): IsolationContext => ({
  agentId: "ag-1",
  agentName: "alice",
  baseCwd: cwd,
  ...overrides,
});

/** Stands in for the host-built worktree strategy: moves the agent into a tree. */
function stubWorktree(
  opts: { refuseRelease?: boolean; failAllocate?: boolean } = {},
): IsolationStrategy {
  return {
    name: "worktree",
    async check() {
      return [];
    },
    async allocate(ctx) {
      if (opts.failAllocate) throw new Error("tree add failed");
      return {
        cwd: `${ctx.baseCwd}/.worktrees/${ctx.agentName}`,
        ref: { branch: `agent-chat/${ctx.agentName}` },
      };
    },
    async release() {
      return !opts.refuseRelease;
    },
  };
}

describe("registry and composition", () => {
  it("resolves each name to its own strategy", () => {
    const worktree = stubWorktree();
    const { getStrategy, resolve } = createIsolationRegistry({ worktree });

    expect(getStrategy("none").name).toBe("none");
    expect(getStrategy("worktree")).toBe(worktree);
    expect(getStrategy("file-ownership").name).toBe("file-ownership");
    expect(getStrategy("toolset-limited").name).toBe("toolset-limited");
    expect(resolve(["worktree"])).toBe(worktree);
    expect(resolve([]).name).toBe("none");
  });

  it("layers a toolset over a worktree: narrowed tools, worktree cwd", async () => {
    const { resolve } = createIsolationRegistry({ worktree: stubWorktree() });
    const ctx = ctxFor("/repo", { toolset: { allowedTools: ["Read", "Edit"] } });

    const alloc = await resolve(["toolset-limited", "worktree"]).allocate(ctx);

    expect(alloc.cwd).toBe("/repo/.worktrees/alice");
    expect(alloc.allowedTools).toEqual(["Read", "Edit"]);
    expect(alloc.note).toContain("Read, Edit");
    expect(alloc.ref).toEqual({ branch: "agent-chat/alice" });
  });

  it("narrows tools across members and never widens them", async () => {
    const granting: IsolationStrategy = {
      ...stubWorktree(),
      async allocate(ctx) {
        return { cwd: ctx.baseCwd, allowedTools: ["Read", "Bash"] };
      },
    };
    const { getStrategy } = createIsolationRegistry({ worktree: stubWorktree() });
    const ctx = ctxFor("/repo", { toolset: { allowedTools: ["Read", "Edit"] } });

    const alloc = await composite([getStrategy("toolset-limited"), granting]).allocate(ctx);

    expect(alloc.allowedTools).toEqual(["Read"]);
  });

  it("propagates a member strategy refusing to release", async () => {
    const { resolve } = createIsolationRegistry({ worktree: stubWorktree({ refuseRelease: true }) });
    const composed = resolve(["toolset-limited", "worktree"]);
    const alloc = await composed.allocate(ctxFor("/repo"));

    expect(await composed.release(ctxFor("/repo"), alloc)).toBe(false);
  });

  it("gathers check output from every member", async () => {
    const { resolve } = createIsolationRegistry({ worktree: stubWorktree() });
    const ctx = ctxFor("/repo", { peers: [{ agentId: "ag-bob", name: "bob", cwd: "/repo" }] });

    const reasons = await resolve(["none", "toolset-limited"]).check(ctx);

    expect(reasons).toHaveLength(2);
    expect(reasons.every(isWarning)).toBe(true);
  });

  it("force-releases what it already allocated when a later member fails", async () => {
    const first = stubWorktree();
    const unwound: Array<ReleaseOptions | undefined> = [];
    const tracked: IsolationStrategy = {
      ...first,
      async release(_ctx, _alloc, opts) {
        unwound.push(opts);
        return true;
      },
    };
    const composed = composite([tracked, stubWorktree({ failAllocate: true })]);

    await expect(composed.allocate(ctxFor("/repo"))).rejects.toThrow("tree add failed");

    expect(unwound).toEqual([{ force: true }]);
  });
});
